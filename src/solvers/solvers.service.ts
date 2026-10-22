import { ConflictException, Inject, Injectable, Logger, Optional } from "@nestjs/common";
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

  async register(
    data: Omit<
      SolverRecord,
      "registeredAt" | "lastActiveAt" | "fillsCompleted" | "fillsFailed" | "totalVolume"
    >,
  ): Promise<SolverRecord> {
    const now = Math.floor(Date.now() / 1000);
    const solver: SolverRecord = {
      ...data,
      fillsCompleted: 0,
      fillsFailed: 0,
      totalVolume: "0",
      registeredAt: now,
      lastActiveAt: now,
    };
    return this.repo.save(solver);
  }

  async deregister(address: string): Promise<SolverRecord | undefined> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return undefined;
    const updated = { ...solver, isActive: false, lastActiveAt: Math.floor(Date.now() / 1000) };
    return this.repo.save(updated);
  }

  async markLive(address: string): Promise<SolverRecord | undefined> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return undefined;
    const updated = { ...solver, isActive: true, lastActiveAt: Math.floor(Date.now() / 1000) };
    return this.repo.save(updated);
  }

  async markOffline(address: string): Promise<SolverRecord | undefined> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return undefined;
    const updated = { ...solver, isActive: false, lastActiveAt: Math.floor(Date.now() / 1000) };
    return this.repo.save(updated);
  }

  async deactivate(address: string): Promise<SolverRecord | null> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return null;
    const updated = { ...solver, isActive: false, lastActiveAt: Math.floor(Date.now() / 1000) };
    return this.repo.save(updated);
  }

  async reactivate(address: string): Promise<SolverRecord | null> {
    if (this.isSuspended(address)) {
      throw new ConflictException("Solver is suspended by an active guardian action");
    }
    const solver = await this.repo.findByAddress(address);
    if (!solver) return null;
    const updated = { ...solver, isActive: true };
    return this.repo.save(updated);
  }

  /**
   * Register a solver from an on-chain SolverRegistered event (issue #399).
   *
   * Creates a new solver record with source="chain" and the bond amount
   * observed on-chain.  Fields not present in the event (name, supported
   * chains/tokens) are set to sensible defaults and can be updated later via
   * POST /solvers metadata update.
   */
  async registerFromChain(params: {
    address: string;
    bondAmount: string;
    name: string;
    isActive: boolean;
    supportedChains: SolverRecord["supportedChains"];
    supportedTokens: SolverRecord["supportedTokens"];
    chainUpdatedLedger: number;
  }): Promise<SolverRecord> {
    const now = Math.floor(Date.now() / 1000);
    const solver: SolverRecord = {
      address: params.address,
      name: params.name,
      bondAmount: params.bondAmount,
      fillsCompleted: 0,
      fillsFailed: 0,
      totalVolume: "0",
      avgFillTime: 0,
      isActive: params.isActive,
      registeredAt: now,
      lastActiveAt: now,
      supportedChains: params.supportedChains,
      supportedTokens: params.supportedTokens,
      source: "chain",
      chainUpdatedLedger: params.chainUpdatedLedger,
    };
    return this.repo.save(solver);
  }

  /**
   * Apply a partial update from an on-chain event projection (issue #399).
   *
   * Only the fields present in `update` are changed — all other fields remain
   * as stored.  Guards on chainUpdatedLedger are enforced by the caller
   * (SolverRegistryEventsService) before this method is called.
   *
   * This is the write path for all chain-sourced projections (BondDeposited,
   * BondWithdrawn, SolverDeactivated, etc.).
   */
  async applyChainUpdate(
    address: string,
    update: Partial<Pick<SolverRecord, "bondAmount" | "isActive" | "source" | "chainUpdatedLedger">>,
  ): Promise<SolverRecord | undefined> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return undefined;
    const updated: SolverRecord = { ...solver, ...update };
    return this.repo.save(updated);
  }
}
