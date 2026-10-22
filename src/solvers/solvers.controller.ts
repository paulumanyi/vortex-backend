import {
	BadRequestException,
	Body,
	Controller,
	Delete,
	ForbiddenException,
	Get,
	NotFoundException,
	Param,
	Patch,
	Post,
	Query,
} from "@nestjs/common";
import {
	ApiBadRequestResponse,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiQuery,
	ApiTags,
	ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { IntentsService } from "../intents/intents.service";
import {
	buildDelegateMessage,
	buildDisputeMessage,
	buildRegisterMessage,
	buildUpdateSolverMessage,
	buildSolverStatusMessage,
	verifyStellarSignature,
} from "../common/stellar-signature";
import { SolversService, LeaderboardWindow, solverSupports } from "./solvers.service";
import { ListIntentsDto } from "../intents/dto/list-intents.dto";
import { RegisterSolverDto } from "./dto/register-solver.dto";
import { UpdateSolverDto } from "./dto/update-solver.dto";
import { UpdateSolverStatusDto } from "./dto/update-solver-status.dto";
import { UpdateSolverInventoryDto } from "./dto/update-solver-inventory.dto";

const WINDOW_SECONDS: Record<Exclude<LeaderboardWindow, "all">, number> = {
	"24h": 24 * 60 * 60,
	"7d": 7 * 24 * 60 * 60,
	"30d": 30 * 24 * 60 * 60,
};

@ApiTags("solvers")
@Controller({ path: "solvers", version: "1" })
export class SolversController {
	constructor(
		private readonly solversService: SolversService,
		private readonly intentsService: IntentsService,
	) {}

	@Post()
	async register(@Body() dto: RegisterSolverDto) {
		verifyStellarSignature(dto.address, buildRegisterMessage(dto.address), dto.proofSignature);

		return this.solversService.register({
			address: dto.address,
			name: dto.name,
			bondAmount: dto.bondAmount,
			avgFillTime: dto.avgFillTime,
			isActive: true,
			supportedChains: dto.supportedChains,
			supportedTokens: dto.supportedTokens,
		});
	}

	@Get("leaderboard")
	@ApiOperation({
		summary: "Windowed solver leaderboard",
		description:
			"Returns the ranked solver list for a specific window. This endpoint is intended for recent-performance visibility and does not alter the legacy all-time leaderboard.",
	})
	@ApiQuery({ name: "window", required: false, enum: ["24h", "7d", "30d", "all"] })
	async getLeaderboard(@Query("window") window: string = "all") {
		const resolvedWindow = this.normalizeWindow(window);
		const solvers = await this.solversService.getAll();
		const intents = await this.intentsService.getAll();
		const now = Math.floor(Date.now() / 1000);
		const cutoff = resolvedWindow === "all" ? 0 : now - WINDOW_SECONDS[resolvedWindow];

		const ranked = solvers
			.map((solver) => {
				const recentIntents = intents.filter((intent) => {
					if (intent.solver !== solver.address || intent.state !== "filled") return false;
					const timestamp = intent.filledAt ?? intent.createdAt;
					return resolvedWindow === "all" || timestamp >= cutoff;
				});
				const slashedRecent = intents.filter((intent) => {
					if (intent.solver !== solver.address || intent.state !== "slashed") return false;
					const timestamp = intent.slashedAt ?? intent.createdAt;
					return resolvedWindow === "all" || timestamp >= cutoff;
				});

				const fillsCompleted = recentIntents.length;
				const fillsFailed = slashedRecent.length;
				const total = fillsCompleted + fillsFailed;
				const successRate = total > 0 ? fillsCompleted / total : 0;
				const ageDays = Math.max(0, (now - solver.registeredAt) / 86400);
				const reputationScore = Number((successRate * Math.exp(-ageDays / 180)).toFixed(4));

				return {
					address: solver.address,
					name: solver.name,
					fillsCompleted,
					fillsFailed,
					successRate: Number(successRate.toFixed(4)),
					reputationScore,
					totalVolume: recentIntents
						.reduce((sum, intent) => sum + BigInt(intent.fillAmount ?? "0"), 0n)
						.toString(),
					avgFillTime: recentIntents.length
						? Math.round(
								recentIntents.reduce((sum, intent) => {
									if (!intent.filledAt) return sum;
									return sum + (intent.filledAt - intent.createdAt);
								}, 0) / recentIntents.length,
							)
						: 0,
					bondAmount: solver.bondAmount,
					isActive: solver.isActive,
					window: resolvedWindow,
				};
			})
			.filter((entry) => entry.fillsCompleted > 0 || entry.fillsFailed > 0 || resolvedWindow === "all")
			.sort((a, b) => b.reputationScore - a.reputationScore || b.fillsCompleted - a.fillsCompleted);

		return { solvers: ranked, count: ranked.length, window: resolvedWindow };
	}

	@Get()
	async getLegacyLeaderboard() {
		const solvers = (await this.solversService.getAll()).sort(
			(a, b) => b.fillsCompleted - a.fillsCompleted,
		);
		return { solvers, count: solvers.length };
	}

	@Get(":address/eligible-intents")
	async getEligibleIntents(@Param("address") address: string, @Query() dto: ListIntentsDto) {
		const solver = await this.solversService.get(address);
		if (!solver) throw new NotFoundException("Solver not found");
		if (!solver.isActive) throw new ForbiddenException("Solver is not active");

		const open = await this.intentsService.getByState("open");
		const eligible = open.filter((intent) => {
			if (!solverSupports(solver, intent.srcChain, intent.srcToken.symbol)) return false;
			const declared = (solver.inventory ?? []).find(
				(entry) => entry.chain === intent.srcChain && entry.token === intent.srcToken.symbol,
			);
			if (!declared) return true;
			try {
				return BigInt(intent.srcAmount) <= BigInt(declared.availableAmount);
			} catch {
				return true;
			}
		});
		const limit = Math.min(dto.limit ?? 20, 100);
		const offset = dto.offset ?? 0;
		if ((dto.limit ?? 20) > 100) {
			throw new BadRequestException("Limit exceeds maximum allowed value of 100");
		}

		const page = eligible.slice(offset, offset + limit);
		return { intents: page, total: eligible.length, count: eligible.length, limit, offset };
	}

	@Get(":address")
	async getSolver(@Param("address") address: string) {
		const solver = await this.solversService.get(address);
		if (!solver) throw new NotFoundException("Solver not found");
		return solver;
	}

	@Patch(":address")
	@ApiOkResponse({ description: "Updated solver record" })
	@ApiBadRequestResponse({ description: "Invalid update body" })
	@ApiUnauthorizedResponse({ description: "Missing or invalid signature" })
	@ApiNotFoundResponse({ description: "Solver not found" })
	async updateSolver(@Param("address") address: string, @Body() dto: UpdateSolverDto) {
		const solver = await this.solversService.get(address);
		if (!solver) throw new NotFoundException("Solver not found");

		const message = buildUpdateSolverMessage(address);
		const signers = [address, ...(solver.delegatedSigners ?? [])];
		let authorized = false;
		for (const signer of signers) {
			try {
				verifyStellarSignature(signer, message, dto.signature);
				authorized = true;
				break;
			} catch {
				// try next candidate signer
			}
		}
		if (!authorized) {
			throw new ForbiddenException("Missing or invalid signature");
		}

		const { signature: _signature, ...patch } = dto;
		const updated = await this.solversService.update(address, patch);
		if (!updated) throw new NotFoundException("Solver not found");
		return updated;
	}

	@Patch(":address/inventory")
	@ApiOperation({ summary: "Declare per-token inventory depth" })
	@ApiOkResponse({ description: "Updated solver record" })
	@ApiBadRequestResponse({ description: "Invalid inventory body" })
	@ApiUnauthorizedResponse({ description: "Missing or invalid signature" })
	@ApiNotFoundResponse({ description: "Solver not found" })
	async updateInventory(
		@Param("address") address: string,
		@Body() dto: UpdateSolverInventoryDto,
	) {
		const solver = await this.solversService.get(address);
		if (!solver) throw new NotFoundException("Solver not found");

		const message = buildUpdateSolverMessage(address);
		const signers = [address, ...(solver.delegatedSigners ?? [])];
		let authorized = false;
		for (const signer of signers) {
			try {
				verifyStellarSignature(signer, message, dto.signature);
				authorized = true;
				break;
			} catch {
				// try next candidate signer
			}
		}
		if (!authorized) {
			throw new ForbiddenException("Missing or invalid signature");
		}

		const updated = await this.solversService.update(address, { inventory: dto.inventory });
		if (!updated) throw new NotFoundException("Solver not found");
		return updated;
	}

	@Post(":address/delegates")
	@ApiOperation({ summary: "Add a delegated operational signer" })
	@ApiOkResponse({ description: "Updated solver record" })
	@ApiUnauthorizedResponse({ description: "Missing or invalid signature" })
	@ApiNotFoundResponse({ description: "Solver not found" })
	async addDelegate(
		@Param("address") address: string,
		@Body() dto: { delegateAddress: string; signature: string },
	) {
		verifyStellarSignature(
			address,
			buildDelegateMessage(address, dto.delegateAddress),
			dto.signature,
		);
		const solver = await this.solversService.addDelegate(address, dto.delegateAddress);
		if (!solver) throw new NotFoundException("Solver not found");
		return solver;
	}

	@Delete(":address/delegates/:delegateAddress")
	@ApiOperation({ summary: "Remove a delegated operational signer" })
	@ApiOkResponse({ description: "Updated solver record" })
	@ApiUnauthorizedResponse({ description: "Missing or invalid signature" })
	@ApiNotFoundResponse({ description: "Solver not found" })
	async removeDelegate(
		@Param("address") address: string,
		@Param("delegateAddress") delegateAddress: string,
		@Body() dto: { signature: string },
	) {
		verifyStellarSignature(
			address,
			buildDelegateMessage(address, delegateAddress),
			dto.signature,
		);
		const solver = await this.solversService.removeDelegate(address, delegateAddress);
		if (!solver) throw new NotFoundException("Solver not found");
		return solver;
	}

	@Patch(":address/status")
	@ApiOperation({ summary: "Update solver active status" })
	@ApiOkResponse({ description: "Updated solver record" })
	@ApiUnauthorizedResponse({ description: "Missing or invalid signature" })
	@ApiNotFoundResponse({ description: "Solver not found" })
	async updateStatus(@Param("address") address: string, @Body() dto: UpdateSolverStatusDto) {
		verifyStellarSignature(
			address,
			buildSolverStatusMessage(address, dto.isActive),
			dto.signature,
		);
		const solver = await this.solversService.update(address, { isActive: dto.isActive });
		if (!solver) throw new NotFoundException("Solver not found");
		return solver;
	}

	private normalizeWindow(window: string): LeaderboardWindow {
		if (window === "24h" || window === "7d" || window === "30d" || window === "all") {
			return window;
		}
		throw new BadRequestException("Invalid window. Use 24h, 7d, 30d, or all");
	}
}
