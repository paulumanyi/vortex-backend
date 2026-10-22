import { BadRequestException, ConflictException, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { SupportedChain } from "../intents/intents.types";
import { SOLVERS_REPOSITORY, ISolversRepository } from "./solvers.repository";
import { SolverRecord, SolverPendingPenalty, MAX_DELEGATED_SIGNERS } from "./solvers.types";
import { GuardianStateService } from "../governance/guardian-state.service";

export type LeaderboardWindow = "24h" | "7d" | "30d" | "all";

export function solverSupports(
  solver: Pick<SolverRecord, "supportedChains" | "supportedTokens">,
  chain: SupportedChain | string,
  token: string,
): boolean {
  if (!solver.supportedChains.includes(chain as SupportedChain) && chain !== "*") {
    return false;
  }
  const normalizedToken = token.toUpperCase();
  return solver.supportedTokens.some((supportedToken) => supportedToken.toUpperCase() === normalizedToken);
}

/**
 * True when the solver has advertised enough inventory depth to cover an
 * intent of `amount` for `(chain, token)` (issue #640).
 *
 * Inventory is opt-in: when the solver has no declared entry for the pair the
 * intent is unaffected. When an entry exists, the intent is only covered if
 * its source amount does not exceed the declared `availableAmount`.
 */
export function solverCoversAmount(
  solver: Pick<SolverRecord, "inventory">,
  chain: SupportedChain | string,
  token: string,
  amount: string,
): boolean {
  const inventory = solver.inventory ?? [];
  const normalizedToken = token.toUpperCase();
  const entry = inventory.find(
    (item) => item.chain === chain && item.token.toUpperCase() === normalizedToken,
  );
  if (!entry) return true;

  let declared: bigint;
  let requested: bigint;
  try {
    declared = BigInt(entry.availableAmount);
    requested = BigInt(amount);
  } catch {
    // Unparseable amounts cannot be proven to fit; treat as not covered.
    return false;
  }
  return requested <= declared;
}

export interface SlashDisputeRecord {
  submittedAt: number;
  reason: string;
  evidenceReference?: string;
}

export interface SlashRecord {
  slashId: string;
  solver: string;
  intentId: string;
  reason: string;
  timestamp: number;
  disputeStatus: "none" | "disputed" | "resolved-upheld" | "resolved-reversed";
  dispute?: SlashDisputeRecord;
}

/**
 * The subset of {@link SolverRecord} a solver is allowed to change about
 * itself. Every other field (address, bond, fill counters, volume,
 * registeredAt, isActive) is immutable and is never accepted here.
 */
export type MutableSolverProfile = Pick<
  SolverRecord,
  "name" | "supportedChains" | "supportedTokens" | "avgFillTime"
>;

/**
 * Orchestration layer for solver records.
 *
 * Business logic (counter initialisation, timestamp generation) lives here.
 * All persistence is delegated to the injected ISolversRepository so the
 * storage adapter can be swapped (in-memory → Prisma) without touching this
 * service or anything above it.
 */
@Injectable()
export class SolversService {
  private readonly logger = new Logger(SolversService.name);
  private readonly slashHistory = new Map<string, SlashRecord[]>();
  private readonly pendingPenalties = new Map<string, SolverPendingPenalty>();
  private slashSequence = 0;

  constructor(
    @Inject(SOLVERS_REPOSITORY)
    private readonly repo: ISolversRepository,
    @Optional() private readonly guardian?: GuardianStateService,
  ) {}

  /**
   * True while an active guardian blacklist covers `address` (issue #507).
   * Derived from guardian state; operators cannot clear it by reactivating.
   */
  isSuspended(address: string): boolean {
    return this.guardian?.isSolverSuspended(address) ?? false;
  }

  async getAll(): Promise<SolverRecord[]> {
    return this.repo.findAll();
  }

  async get(address: string): Promise<SolverRecord | undefined> {
    return this.repo.findByAddress(address);
  }

  /**
   * Resolve a referral code to the referrer's address (issue #641).
   *
   * A referral code is simply the referrer's own address. It must resolve to
   * an existing, active solver and must not be the registrant's own address.
   *
   * @returns the referrer address, or `undefined` when no code was supplied.
   * @throws BadRequestException for self-referral or an unknown/inactive code.
   */
  async resolveReferralCode(
    referralCode: string | undefined,
    registrantAddress: string,
  ): Promise<string | undefined> {
    if (referralCode === undefined || referralCode === null || referralCode === "") {
      return undefined;
    }
    if (referralCode === registrantAddress) {
      throw new BadRequestException("A solver cannot refer itself");
    }
    const referrer = await this.repo.findByAddress(referralCode);
    if (!referrer || !referrer.isActive) {
      throw new BadRequestException("Referral code does not resolve to an active solver");
    }
    return referrer.address;
  }

  /**
   * List the solver addresses referred by `address` (issue #641).
   *
   * Derived by scanning for records whose immutable `referredBy` matches the
   * given address. A referrer that later deregisters keeps its past referral
   * records intact.
   */
  async getReferrals(address: string): Promise<string[]> {
    const all = await this.repo.findAll();
    return all
      .filter((solver) => solver.referredBy === address)
      .map((solver) => solver.address);
  }

  /**
   * True when `signer` is the primary address of `solver` or one of its
   * current delegated operational signers (issue #639).
   */
  isAuthorizedSigner(solver: SolverRecord, signer: string): boolean {
    if (solver.address === signer) return true;
    return (solver.delegatedSigners ?? []).includes(signer);
  }

  /**
   * Add a delegated operational signer to a solver (issue #639).
   *
   * Idempotent: re-adding an existing delegate is a no-op. Rejects delegates
   * that are already registered as their own independent solver, and enforces
   * the {@link MAX_DELEGATED_SIGNERS} cap.
   */
  async addDelegate(address: string, delegateAddress: string): Promise<SolverRecord | undefined> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return undefined;

    const current = solver.delegatedSigners ?? [];
    if (current.includes(delegateAddress)) return solver;

    if (delegateAddress === address) {
      throw new ConflictException("Primary address cannot be its own delegate");
    }
    const existing = await this.repo.findByAddress(delegateAddress);
    if (existing) {
      throw new ConflictException("Delegate address is already a registered solver");
    }
    if (current.length >= MAX_DELEGATED_SIGNERS) {
      throw new ConflictException(
        `Solver already has the maximum of ${MAX_DELEGATED_SIGNERS} delegated signers`,
      );
    }

    const updated: SolverRecord = { ...solver, delegatedSigners: [...current, delegateAddress] };
    return this.repo.save(updated);
  }

  /**
   * Remove a delegated operational signer (issue #639). Removing a delegate
   * never touches the bond or history; unknown delegates are a no-op.
   */
  async removeDelegate(address: string, delegateAddress: string): Promise<SolverRecord | undefined> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return undefined;

    const current = solver.delegatedSigners ?? [];
    if (!current.includes(delegateAddress)) return solver;

    const updated: SolverRecord = {
      ...solver,
      delegatedSigners: current.filter((signer) => signer !== delegateAddress),
    };
    return this.repo.save(updated);
  }

  /**
   * Replace a solver's self-reported inventory depth declarations (issue #640).
   *
   * The list is replaced wholesale, mirroring how `supportedChains` /
   * `supportedTokens` are patched. An empty list clears all declarations and
   * restores the pre-#640 behaviour (no amount filtering).
   */
  async updateInventory(
    address: string,
    inventory: NonNullable<SolverRecord["inventory"]>,
  ): Promise<SolverRecord | undefined> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return undefined;

    const updated: SolverRecord = { ...solver, inventory };
    return this.repo.save(updated);
  }

  /**
   * Apply a partial patch to a solver's *mutable* profile fields (issue #273).
   *
   * Array fields (`supportedChains`, `supportedTokens`) are replaced wholesale
   * rather than merged — the API is a PATCH over a full replacement list, and
   * a merge would make it impossible to drop a chain.
   *
   * Keys whose value is `undefined` are skipped, so a caller that spreads a
   * partially-populated DTO cannot accidentally blank out an existing value.
   * Immutable fields are structurally impossible to set: the patch type only
   * admits {@link MutableSolverProfile}.
   *
   * @returns the updated record, or `undefined` when no solver has that address.
   */
  async update(
    address: string,
    patch: Partial<MutableSolverProfile>,
  ): Promise<SolverRecord | undefined> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return undefined;

    const applied: Partial<MutableSolverProfile> = {};
    if (patch.name !== undefined) applied.name = patch.name;
    if (patch.avgFillTime !== undefined) applied.avgFillTime = patch.avgFillTime;
    if (patch.supportedChains !== undefined) applied.supportedChains = patch.supportedChains;
    if (patch.supportedTokens !== undefined) applied.supportedTokens = patch.supportedTokens;

    const updated: SolverRecord = { ...solver, ...applied };
    return this.repo.save(updated);
  }
}
