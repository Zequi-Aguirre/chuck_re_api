import { injectable } from "tsyringe";
import { RealEstateApiDao } from "../data/RealEstateApiDao.ts";
import { GhlApiClient } from "../ghlEnrichment/api/GhlApiClient.ts";
import { GhlConnectionService } from "../ghlEnrichment/connections/GhlConnectionService.ts";
import { GhlConnection } from "../ghlEnrichment/connections/GhlConnectionTypes.ts";
import { JakeGatewayClient } from "../ghlEnrichment/gateway/JakeGatewayClient.ts";
import { CreditService } from "../ghlEnrichment/metering/CreditService.ts";
import { TextJakeCustomerService } from "../ghlEnrichment/customers/TextJakeCustomerService.ts";
import { ConversationMemoryService } from "../ghlEnrichment/conversation/ConversationMemoryService.ts";
import { LookupRow } from "../ghlEnrichment/conversation/ConversationTypes.ts";
import { TextJakeCustomer } from "../ghlEnrichment/customers/TextJakeCustomerTypes.ts";
import { normalizeInboundAddress } from "../util/address.ts";
import { JakeInboundMessage, JakeInboundResult, JakeTextMode } from "../types/Jake.ts";
import {
    RealEstateApiMailingAddress,
    RealEstateApiPropertyCompsResponse,
    RealEstateApiPropertySearchResult,
    RealEstateApiSkipTraceEmail,
    RealEstateApiSkipTracePerson,
    RealEstateApiSkipTracePhone,
    RealEstateApiSkipTraceResult,
} from "../types/RealEstateApi.ts";
import { PropertyReportWriter } from "./PropertyReportWriter.ts";
import { JakeOrchestrator } from "./orchestrator/JakeOrchestrator.ts";
import { DispatchPlan, JakeIntent } from "./orchestrator/OrchestratorTypes.ts";
import {
    OrdinalSelection,
    parseOrdinalSelection,
    parsePersonReference,
} from "./orchestrator/references.ts";
import { DisambiguationMemoryService } from "./disambiguation/DisambiguationMemoryService.ts";
import { DisambiguationPendingRow } from "./disambiguation/DisambiguationTypes.ts";
import { SkipTraceReportWriter } from "./skiptrace/SkipTraceReportWriter.ts";
import { SkipTraceMemoryService } from "./skiptrace/SkipTraceMemoryService.ts";
import { SkipTraceSettingsService } from "./skiptrace/SkipTraceSettingsService.ts";
import { SkipTraceData, SkipTraceRow, hasContactInfo } from "./skiptrace/SkipTraceTypes.ts";
import { CompsReportWriter } from "./comps/CompsReportWriter.ts";
import { CompsMemoryService } from "./comps/CompsMemoryService.ts";
import { CompsSettingsService } from "./comps/CompsSettingsService.ts";
import {
    CompParamOverrides,
    CompParams,
    CompsRow,
    assembleCompsData,
    formatCompParams,
    hasComps,
    resolveCompParams,
} from "./comps/CompsTypes.ts";
import {
    AbsenteeStatus,
    EquityLevel,
    OccupancyStatus,
    PropertyReportData,
} from "../types/PropertyReport.ts";

/**
 * A resolved transport for one inbound text: which mode handled it and the two
 * verbs the flow needs, already bound to the right client + (for own_number)
 * location. This is how mode-selection stays out of the core flow below.
 */
interface TextRoute {
    mode: JakeTextMode;
    /** The own_number location this route sends on; undefined for the gateway. */
    locationId?: string;
    /** Send the SMS reply. */
    send(contactId: string, message: string): Promise<unknown>;
    /** Write a status note on the customer's contact. */
    note(contactId: string, body: string): Promise<unknown>;
}

const OUT_OF_CREDITS_REPLY =
    "You're out of Jake credits, so I couldn't run that lookup. Top up and text the address again.";

/**
 * The brief ACK Jake sends before a confirmed paid specialist (skip-trace / comps)
 * that hits a paid API + the LLM writer, so the texter isn't left waiting in
 * silence; the result follows in a second message (JAK-138 latency polish).
 */
const ACK_REPLY = "Working on it, one moment.";

@injectable()
export class JakeAssistantService {
    /** The bare tokens that count as a spend confirmation (JAK-138 unified confirm). */
    private static readonly AFFIRMATIVES = new Set([
        "ok",
        "okay",
        "yes",
        "yeah",
        "yep",
        "yup",
        "y",
        "sure",
    ]);

    constructor(
        private readonly realEstateDao: RealEstateApiDao,
        private readonly ghlClient: GhlApiClient,
        private readonly gateway: JakeGatewayClient,
        private readonly connections: GhlConnectionService,
        private readonly customers: TextJakeCustomerService,
        private readonly credits: CreditService,
        private readonly reportWriter: PropertyReportWriter,
        private readonly memory: ConversationMemoryService,
        private readonly orchestrator: JakeOrchestrator,
        private readonly skipTraceWriter: SkipTraceReportWriter,
        private readonly skipTrace: SkipTraceMemoryService,
        private readonly skipTraceSettings: SkipTraceSettingsService,
        private readonly compsWriter: CompsReportWriter,
        private readonly comps: CompsMemoryService,
        private readonly compsSettings: CompsSettingsService,
        private readonly disambiguation: DisambiguationMemoryService
    ) {}

    /**
     * Core text-Jake path (JAK-115), MODE-AWARE, now ORCHESTRATED (JAK-135):
     *   1. resolve the texting CUSTOMER by sender phone (the billing identity —
     *      both modes); upsert a Postgres record + its credit account (JAK-109).
     *   2. resolve the text MODE: if an active connection owns this inbound and is
     *      set to 'own_number', run inside THAT customer's own GHL sub-account on
     *      their per-tenant key + number (the JAK-114 path). Otherwise 'gateway':
     *      run through Zequi's shared Jake sub-account on the master gateway key.
     *   3. persist the inbound message in ordered per-phone memory (JAK-134).
     *   4. ask the ORCHESTRATOR to classify intent + resolve references into a
     *      typed dispatch plan (JAK-135), then execute it — this REPLACES the old
     *      single-path address branch with orchestrated dispatch.
     *
     * Cross-tenant isolation holds: own_number only ever sends/notes on the
     * resolved connection's own creds + a number proven to be its own; the gateway
     * path never touches a tenant key; and each customer bills only their own
     * phone/credits.
     */
    public async handleInboundMessage(input: JakeInboundMessage): Promise<JakeInboundResult> {
        // 1. Billing identity — the texting customer, keyed by sender phone.
        const customer = await this.customers.resolveByPhone(input.senderPhone, input.contactId);
        const accountId = customer.creditAccountId;
        const phone = customer.phone;

        // 2. Mode + transport.
        const route = await this.resolveRoute(input);

        const address = normalizeInboundAddress(input.message);

        // 3. Persist EVERY inbound message in ordered per-phone memory (JAK-134),
        //    with the address we resolved from it (null when it wasn't one). The
        //    returned id links any resulting lookup snapshot back to this message.
        const inboundId = await this.rememberInbound(customer, phone, input.message, address, route);

        // 4. Classify intent + resolve references against memory (JAK-135). The
        //    router reads the recent window + the ordered resolved-address list and
        //    returns a typed plan; we dispatch on it below.
        const plan = await this.orchestrator.plan({
            phone,
            message: input.message,
            parsedAddress: address,
            isAffirmative: this.isAffirmativeOk(input.message),
        });

        const result = await this.dispatch(plan, {
            input,
            route,
            customer,
            accountId,
            phone,
            requestingMessageId: inboundId,
        });
        return { ...result, intent: plan.intent };
    }

    /**
     * Execute a dispatch plan (JAK-135). Report intents keep the FULL JAK-134
     * cache-and-free-reserve behavior; skip-trace (JAK-136) and comps (JAK-137) run
     * immediately on ask (JAK-144, no confirm) with the SAME cache-and-free-reserve;
     * chitchat → guidance.
     */
    private async dispatch(
        plan: DispatchPlan,
        ctx: {
            input: JakeInboundMessage;
            route: TextRoute;
            customer: TextJakeCustomer;
            accountId: string;
            phone: string;
            requestingMessageId: string | null;
        }
    ): Promise<JakeInboundResult> {
        const { input, route, customer, accountId, phone, requestingMessageId } = ctx;

        // Disambiguation follow-up (JAK-138): a bare number/ordinal ("2", "the last
        // one") right after Jake listed addresses and asked WHICH one — resolve it
        // against the stable per-phone resolved-address list and run the intent that
        // was waiting on the pick. Checked FIRST, and gated on a FRESH pending
        // question, so a stray number never fires an action on its own.
        const selection = parseOrdinalSelection(input.message);
        if (selection != null) {
            const pendingAsk = await this.disambiguation.freshPending(phone);
            if (pendingAsk) {
                return this.runDisambiguated({
                    input,
                    route,
                    customer,
                    accountId,
                    phone,
                    requestingMessageId,
                    pending: pendingAsk,
                    selection,
                });
            }
        }

        // JAK-144: skip-trace and comps no longer gate on a "reply OK" confirmation
        // — when the texter asks, the action runs immediately and charges on success
        // (see handleSkipTrace / handleComps). So there is NO pending specialist
        // offer to confirm here; a bare "OK" only ever means a property-report
        // refresh, handled by the report_refresh case below.

        switch (plan.intent) {
            // A bare "OK"/"yes" confirming a fresh PAID copy of the last address
            // (JAK-134 confirm-before-spend). The target is the last address in
            // memory; absent one, fall through to guidance.
            case "report_refresh": {
                const lastAddress = await this.memory.lastResolvedAddress(phone);
                if (lastAddress) {
                    return this.freshLookup({
                        input,
                        route,
                        customer,
                        accountId,
                        phone,
                        address: lastAddress,
                        requestingMessageId,
                        onOkRefresh: true,
                    });
                }
                return this.sendGuidance(input, route, customer, phone);
            }

            // A report for a resolved address (typed directly, or resolved from a
            // reference like "the 2nd address I sent"). Keeps the JAK-134 cache
            // rule: a hit within the free window re-serves for FREE; a miss is a
            // normal paid lookup, charged on match and snapshotted.
            case "property_report": {
                // Resolve the address, or ASK when the reference is ambiguous /
                // out of range (JAK-138) instead of silently falling to guidance.
                const resolution = await this.resolveAddressTarget(plan, phone);
                if (resolution.kind === "ask") {
                    return this.askWhichAddress({
                        input,
                        route,
                        customer,
                        phone,
                        intent: "property_report",
                        compParams: null,
                        addresses: resolution.addresses,
                        outOfRange: resolution.outOfRange,
                        requested: resolution.requested,
                    });
                }
                if (resolution.kind !== "resolved") {
                    return this.sendGuidance(input, route, customer, phone);
                }
                const target = resolution.target;
                // Moving on to a report cancels any outstanding skip-trace or comps
                // quote (and any pending address question) so a later bare "OK" or
                // number can't fire a stale (paid) action.
                await this.clearSkipTracePending(phone);
                await this.clearCompsPending(phone);
                await this.clearDisambiguationPending(phone);
                const cached = await this.memory.checkCache(phone, target);
                if (cached) {
                    return this.reserveFromCache({ input, route, customer, phone, address: target, cached });
                }
                return this.freshLookup({
                    input,
                    route,
                    customer,
                    accountId,
                    phone,
                    address: target,
                    requestingMessageId,
                    onOkRefresh: false,
                });
            }

            // Owner skip trace (JAK-136): built + credit-gated, runs immediately on
            // ask (JAK-144, no confirm), with the SAME cache-and-free-reserve rule.
            case "skip_trace":
                return this.handleSkipTrace({
                    input,
                    route,
                    customer,
                    accountId,
                    phone,
                    plan,
                    requestingMessageId,
                });

            // Comps / CMA (JAK-137): built + credit-gated, runs immediately on ask
            // (JAK-144, no confirm), with texter-tunable parameters and the SAME
            // cache-and-free-reserve rule.
            case "comps":
                return this.handleComps({
                    input,
                    route,
                    customer,
                    accountId,
                    phone,
                    plan,
                    requestingMessageId,
                });

            // Greeting / unrecognized / "help" — the capability menu, no lookup, no
            // charge. A non-affirmative reply here also CANCELS any outstanding paid
            // quote or pending question cleanly, so nothing is left stuck (JAK-138).
            case "chitchat":
            default:
                await this.clearSkipTracePending(phone);
                await this.clearCompsPending(phone);
                await this.clearDisambiguationPending(phone);
                return this.sendGuidance(input, route, customer, phone);
        }
    }

    /**
     * The paid-lookup path, shared by a cache miss and an OK refresh. Enforces the
     * credit gate, runs the PropertySearch, replies, charges only on a delivered
     * match, and SNAPSHOTS the match so a repeat within the free window re-serves
     * for free. In dev/stg the RealEstate DAO returns its mock (no real spend), so
     * this path is safe to exercise off prod.
     */
    private async freshLookup(ctx: {
        input: JakeInboundMessage;
        route: TextRoute;
        customer: TextJakeCustomer;
        accountId: string;
        phone: string;
        address: string;
        requestingMessageId: string | null;
        onOkRefresh: boolean;
    }): Promise<JakeInboundResult> {
        const { input, route, customer, accountId, phone, address } = ctx;

        // Credit gate — never look up for free.
        if (!(await this.credits.hasCreditsForTextLookup(accountId))) {
            await this.sendAndRemember(route, input.contactId, customer, phone, OUT_OF_CREDITS_REPLY);
            await this.writeStatusNote(
                route,
                input.contactId,
                `Jake (text): out of credits — skipped lookup for "${address}".`
            );
            return {
                ok: false,
                address,
                reply: OUT_OF_CREDITS_REPLY,
                mode: route.mode,
                charged: 0,
                outOfCredits: true,
            };
        }

        let property: RealEstateApiPropertySearchResult | null;
        try {
            property = await this.realEstateDao.searchPropertyByAddress(address);
        } catch (err) {
            const reply = `Sorry — I hit a snag looking up "${address}". Please try again shortly.`;
            await this.sendAndRemember(route, input.contactId, customer, phone, reply);
            await this.writeStatusNote(
                route,
                input.contactId,
                `Jake (text): lookup FAILED for "${address}" (${this.errorSummary(err)}).`
            );
            return { ok: false, address, reply, mode: route.mode, charged: 0 };
        }

        const reply = await this.buildReply(address, property);
        await this.sendAndRemember(route, input.contactId, customer, phone, reply);

        // Charge only when a match was delivered — mirrors the enrichment worker's
        // "no match, no charge" policy (the lookup cost is ours). On a match, also
        // snapshot the result for the free re-serve rule.
        let charged = 0;
        if (property) {
            const charge = await this.credits.chargeForTextLookup({ accountId });
            charged = charge.ok ? this.credits.costOfTextLookup() : 0;
            await this.rememberLookup({
                customer,
                phone,
                requestingMessageId: ctx.requestingMessageId,
                address,
                property,
                reportText: reply,
            });
        }

        await this.writeStatusNote(
            route,
            input.contactId,
            property
                ? `Jake (text): ${ctx.onOkRefresh ? "fresh copy on OK for" : "looked up"} "${address}" — charged ${charged} credit(s).`
                : `Jake (text): no property match for "${address}" — no charge.`
        );

        return { ok: true, address, reply, mode: route.mode, charged, refreshed: ctx.onOkRefresh || undefined };
    }

    /**
     * Free re-serve (JAK-134): a repeat of the same address within the free window.
     * We return the STORED report verbatim — no paid API call, no LLM call, no
     * credit — with one appended line telling the texter it's already on record and
     * to reply OK for a fresh copy. The GoTextJake.com footer stays last.
     */
    private async reserveFromCache(ctx: {
        input: JakeInboundMessage;
        route: TextRoute;
        customer: TextJakeCustomer;
        phone: string;
        address: string;
        cached: LookupRow;
    }): Promise<JakeInboundResult> {
        const { input, route, customer, phone, address, cached } = ctx;
        const reply = this.withReserveNotice(cached.report_text, this.credits.costOfTextLookup());
        await this.sendAndRemember(route, input.contactId, customer, phone, reply);
        await this.writeStatusNote(
            route,
            input.contactId,
            `Jake (text): re-served cached report for "${address}" for FREE — no charge, no API call.`
        );
        return { ok: true, address, reply, mode: route.mode, charged: 0, reserved: true };
    }

    // ── Skip trace (JAK-136) ─────────────────────────────────────────────────

    /**
     * Handle a skip-trace request (JAK-136 / JAK-144). Resolves the target address
     * (the router's resolved entity, else the last address the texter sent). Then:
     *   - a repeat trace of the SAME target within the free window → re-serve the
     *     stored result FREE (no spend, no prompt);
     *   - a fresh trace → run it IMMEDIATELY (JAK-144 removed the "reply OK" step):
     *     credit-gate first, then call the paid trace and charge ONLY on a delivered
     *     contact match.
     * Insufficient balance → a clear, no-charge message; the trace does not run.
     */
    private async handleSkipTrace(ctx: {
        input: JakeInboundMessage;
        route: TextRoute;
        customer: TextJakeCustomer;
        accountId: string;
        phone: string;
        plan: DispatchPlan;
        requestingMessageId: string | null;
    }): Promise<JakeInboundResult> {
        const { input, route, customer, accountId, phone, plan } = ctx;

        // Explicit person reference into a prior trace ("the 3rd person / that
        // owner"): resolve against the last skip-trace's entities BEFORE any address
        // handling (JAK-138). Only when the router didn't already resolve a concrete
        // address in this message.
        if (!plan.targetEntity) {
            const personHandled = await this.resolveSkipTracePerson(ctx);
            if (personHandled) return personHandled;
        }

        // Resolve the address to trace, or ASK when the reference is ambiguous /
        // out of range (JAK-138) instead of silently guessing.
        const resolution = await this.resolveAddressTarget(plan, phone);
        if (resolution.kind === "ask") {
            return this.askWhichAddress({
                input,
                route,
                customer,
                phone,
                intent: "skip_trace",
                compParams: null,
                addresses: resolution.addresses,
                outOfRange: resolution.outOfRange,
                requested: resolution.requested,
            });
        }
        const target =
            resolution.kind === "resolved" ? resolution.target : await this.memory.lastResolvedAddress(phone);
        if (!target) {
            const reply = [
                "Text me a property address first, then I can skip-trace the owner and pull their contact info.",
                PropertyReportWriter.FOOTER,
            ].join("\n\n");
            await this.sendAndRemember(route, input.contactId, customer, phone, reply);
            await this.writeStatusNote(
                route,
                input.contactId,
                "Jake (text): skip-trace asked with no address to trace — sent guidance, no charge."
            );
            return { ok: true, address: null, reply, mode: route.mode, charged: 0 };
        }

        const cost = await this.skipTraceSettings.costOfSkipTrace();

        // Free re-serve: a repeat trace of the same target within the free window.
        const cached = await this.skipTrace.checkCache(phone, target);
        if (cached) {
            return this.reserveSkipTraceFromCache({ input, route, customer, phone, target, cached, cost });
        }

        // JAK-144: run immediately — NO "reply OK" confirmation. Credit gate FIRST:
        // insufficient balance → do NOT run, reply with the clear no-charge message.
        if (!(await this.credits.hasCreditsForSkipTrace(accountId, cost))) {
            const balance = await this.credits.getBalance(accountId);
            const reply = [
                `A skip trace on ${target} costs ${cost} credit${cost === 1 ? "" : "s"}, but you have ${balance}. ` +
                    "Top up and text me again to run it — I haven't charged you anything.",
                PropertyReportWriter.FOOTER,
            ].join("\n\n");
            await this.sendAndRemember(route, input.contactId, customer, phone, reply);
            await this.writeStatusNote(
                route,
                input.contactId,
                `Jake (text): skip trace for "${target}" needs ${cost} credit(s), balance ${balance} — declined, no charge.`
            );
            return { ok: false, address: target, reply, mode: route.mode, charged: 0, outOfCredits: true };
        }

        // Sufficient balance → run the paid trace right now. Charged ONLY on a
        // delivered contact match (no charge on failure / no data).
        return this.runSkipTrace({
            input,
            route,
            customer,
            accountId,
            phone,
            target,
            credits: cost,
            requestingMessageId: ctx.requestingMessageId,
        });
    }

    /**
     * Free re-serve (JAK-136 / JAK-144) of a skip trace: a repeat of the same target
     * within the free window. Return the STORED reply verbatim — no paid API call, no
     * LLM call, no credit — with an appended line noting it's already on record and
     * free. No "reply OK" prompt (JAK-144 removed confirm-before-spend). The
     * GoTextJake.com footer stays last.
     */
    private async reserveSkipTraceFromCache(ctx: {
        input: JakeInboundMessage;
        route: TextRoute;
        customer: TextJakeCustomer;
        phone: string;
        target: string;
        cached: SkipTraceRow;
        cost: number;
    }): Promise<JakeInboundResult> {
        const { input, route, customer, phone, target, cached } = ctx;
        const reply = this.withSkipTraceReserveNotice(cached.report_text);
        await this.sendAndRemember(route, input.contactId, customer, phone, reply);
        await this.writeStatusNote(
            route,
            input.contactId,
            `Jake (text): re-served cached skip trace for "${target}" for FREE — no charge, no API call.`
        );
        return { ok: true, address: target, reply, mode: route.mode, charged: 0, reserved: true };
    }

    /**
     * Run a skip trace (JAK-136 / JAK-144) — reached directly from handleSkipTrace
     * once the credit gate passes (NO "reply OK" step anymore). Calls the paid
     * /v2/SkipTrace (mock/no-spend off prod) and charges the cost ONLY when the trace
     * delivered usable contact info — the "no data, no charge" safety is preserved.
     * On a hit it snapshots the result so a repeat within the free window re-serves
     * for free. The caller has already verified the balance, so this does not re-gate.
     */
    private async runSkipTrace(ctx: {
        input: JakeInboundMessage;
        route: TextRoute;
        customer: TextJakeCustomer;
        accountId: string;
        phone: string;
        target: string;
        credits: number;
        requestingMessageId: string | null;
    }): Promise<JakeInboundResult> {
        const { input, route, customer, accountId, phone, target, credits } = ctx;

        // The paid trace + the LLM writer can take a moment; ack now and deliver the
        // result in a follow-up so the texter isn't left waiting silently (JAK-138).
        await this.sendAck(route, input.contactId);

        let record: RealEstateApiSkipTraceResult | null;
        try {
            record = await this.realEstateDao.skipTraceByAddress(target);
        } catch (err) {
            const reply = `Sorry — I hit a snag skip-tracing "${target}". Please try again shortly.`;
            await this.sendAndRemember(route, input.contactId, customer, phone, reply);
            await this.writeStatusNote(
                route,
                input.contactId,
                `Jake (text): skip trace FAILED for "${target}" (${this.errorSummary(err)}) — no charge.`
            );
            return { ok: false, address: target, reply, mode: route.mode, charged: 0 };
        }

        const data = this.assembleSkipTraceData(record, target);
        if (!record || !hasContactInfo(data)) {
            const reply = [
                `I couldn't find owner contact info for ${target}, so I haven't charged you.`,
                PropertyReportWriter.FOOTER,
            ].join("\n\n");
            await this.sendAndRemember(route, input.contactId, customer, phone, reply);
            await this.writeStatusNote(
                route,
                input.contactId,
                `Jake (text): no skip-trace contact match for "${target}" — no charge.`
            );
            return { ok: true, address: target, reply, mode: route.mode, charged: 0 };
        }

        const reply = await this.skipTraceWriter.write(data, record);
        await this.sendAndRemember(route, input.contactId, customer, phone, reply);

        const charge = await this.credits.chargeForSkipTrace({ accountId, credits });
        const charged = charge.ok ? credits : 0;
        await this.rememberSkipTrace({
            customer,
            phone,
            requestingMessageId: ctx.requestingMessageId,
            target,
            record,
            reportText: reply,
        });

        await this.writeStatusNote(
            route,
            input.contactId,
            `Jake (text): skip traced "${target}" — charged ${charged} credit(s).`
        );
        return { ok: true, address: target, reply, mode: route.mode, charged, refreshed: undefined };
    }

    /**
     * Append the skip-trace free-re-serve notice to a stored reply, KEEPING the
     * GoTextJake.com footer last (mirrors {@link withReserveNotice}).
     */
    private withSkipTraceReserveNotice(reportText: string): string {
        const notice = "This owner is already on record, so this copy is free.";
        const footer = PropertyReportWriter.FOOTER;
        const trimmed = reportText.trimEnd();
        const body = trimmed.endsWith(footer)
            ? trimmed.slice(0, trimmed.length - footer.length).trimEnd()
            : trimmed;
        return `${body}\n\n${notice}\n\n${footer}`;
    }

    /** Clear a phone's outstanding skip-trace offer (best-effort; never blocks the reply). */
    private async clearSkipTracePending(phone: string): Promise<void> {
        try {
            await this.skipTrace.clearPending(phone);
        } catch (err) {
            console.error("⚠️ Jake skip-trace pending clear failed:", this.errorSummary(err));
        }
    }

    /** Snapshot a paid skip trace for the free re-serve rule (best-effort memory). */
    private async rememberSkipTrace(input: {
        customer: TextJakeCustomer;
        phone: string;
        requestingMessageId: string | null;
        target: string;
        record: RealEstateApiSkipTraceResult;
        reportText: string;
    }): Promise<void> {
        try {
            await this.skipTrace.recordTrace({
                customerId: input.customer.id,
                phone: input.phone,
                messageId: input.requestingMessageId,
                normalizedTarget: input.target,
                traceRecord: input.record,
                reportText: input.reportText,
            });
        } catch (err) {
            console.error("⚠️ Jake skip-trace snapshot failed:", this.errorSummary(err));
        }
    }

    /**
     * Map a raw /v2/SkipTrace record into the clean, verified {@link SkipTraceData}
     * the writer consumes. Only PRESENT values are set (missing → left undefined),
     * pulled defensively from the shapes the provider ships — nested under
     * `output.identity` or flattened onto the record — and de-duplicated. Never
     * fabricates a name/phone/email/address.
     */
    private assembleSkipTraceData(
        record: RealEstateApiSkipTraceResult | null,
        target: string
    ): SkipTraceData {
        const data: SkipTraceData = {};
        if (target.trim()) data.targetAddress = target.trim();
        if (!record) return data;

        // JAK-144: the LIVE provider returns matches under a top-level `persons[]`
        // array; older/other account shapes nest a single identity under
        // `output.identity` or flatten phones/emails onto the record. Read all of
        // them defensively so every shape resolves — never fabricating a value.
        const persons = record.persons ?? [];
        const identity = record.output?.identity ?? null;

        const ownerName = this.skipTraceOwnerName(record, identity, persons);
        if (ownerName) data.ownerName = ownerName;

        const rawPhones: RealEstateApiSkipTracePhone[] = [
            ...persons.flatMap((p) => p.phones ?? []),
            ...(identity?.phones ?? []),
            ...(record.phones ?? []),
        ];
        const phones = this.dedupe(rawPhones.map((p) => this.phoneDisplay(p)));
        if (phones.length) data.phones = phones;

        const rawEmails: Array<string | RealEstateApiSkipTraceEmail> = [
            ...persons.flatMap((p) => p.emails ?? []),
            ...(identity?.emails ?? []),
            ...(record.emails ?? []),
        ];
        const emails = this.dedupe(rawEmails.map((e) => this.emailDisplay(e)));
        if (emails.length) data.emails = emails;

        const mailing = this.mailingDisplay(
            persons[0]?.address ?? identity?.address ?? record.mailAddress ?? null
        );
        if (mailing) data.mailingAddress = mailing;

        return data;
    }

    private skipTraceOwnerName(
        record: RealEstateApiSkipTraceResult,
        identity: NonNullable<NonNullable<RealEstateApiSkipTraceResult["output"]>["identity"]> | null,
        persons: RealEstateApiSkipTracePerson[]
    ): string | null {
        // Prefer the first matched person's name (live shape).
        const person = persons[0];
        if (person) {
            const full = this.text(person.fullName) ?? this.text(person.name);
            if (full) return full;
            const composed = [person.firstName, person.lastName].filter(Boolean).join(" ").trim();
            if (composed) return composed;
        }
        const top = this.text(record.name) ?? this.text(identity?.name);
        if (top) return top;
        const first = identity?.names?.[0];
        if (typeof first === "string") return this.text(first);
        if (first && typeof first === "object") {
            const full = this.text(first.fullName);
            if (full) return full;
            const composed = [first.firstName, first.lastName].filter(Boolean).join(" ").trim();
            return composed || null;
        }
        return null;
    }

    /** A skip-trace email may be a plain string (live shape) or an `{ email }`/`{ address }` object. */
    private emailDisplay(e: string | RealEstateApiSkipTraceEmail): string {
        if (typeof e === "string") return this.text(e) ?? "";
        return this.text(e?.email ?? e?.address) ?? "";
    }

    private phoneDisplay(p: RealEstateApiSkipTracePhone): string {
        return (
            this.text(p?.phoneDisplay) ??
            this.text(p?.phone) ??
            this.text(p?.number) ??
            this.text(p?.telephone) ??
            ""
        );
    }

    private mailingDisplay(mail: RealEstateApiMailingAddress | null): string | null {
        if (!mail) return null;
        const label = this.text(mail.label);
        if (label) return label;
        const line1 = this.text(mail.address);
        const tail = [this.text(mail.city), this.text(mail.state), this.text(mail.zip)]
            .filter(Boolean)
            .join(" ");
        const parts = [line1, tail].filter(Boolean);
        return parts.length ? parts.join(", ") : null;
    }

    /** Trim, drop blanks, and de-duplicate a list of display strings (order-preserving). */
    private dedupe(values: string[]): string[] {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const v of values) {
            const t = (v ?? "").trim();
            if (!t || seen.has(t.toLowerCase())) continue;
            seen.add(t.toLowerCase());
            out.push(t);
        }
        return out;
    }

    // ── Comps / CMA (JAK-137) ────────────────────────────────────────────────

    /**
     * Handle a comps request (JAK-137 / JAK-144). Resolves the target address (the
     * router's resolved entity, else the last address the texter sent) and the
     * effective parameters (admin defaults overlaid with any texter overrides the
     * router extracted, then clamped). Then, mirroring skip-trace:
     *   - a repeat request for the SAME target AND parameter-set within the free
     *     window → re-serve the stored result FREE (no spend, no prompt);
     *   - a fresh request → run it IMMEDIATELY (JAK-144 removed the "reply OK" step):
     *     credit-gate first, then pull comps and charge ONLY when at least one
     *     comparable sale is delivered. Insufficient balance → a clear no-charge
     *     message; the pull does not run.
     */
    private async handleComps(ctx: {
        input: JakeInboundMessage;
        route: TextRoute;
        customer: TextJakeCustomer;
        accountId: string;
        phone: string;
        plan: DispatchPlan;
        requestingMessageId: string | null;
    }): Promise<JakeInboundResult> {
        const { input, route, customer, accountId, phone, plan } = ctx;

        // Resolve the address, or ASK when the reference is ambiguous / out of range
        // (JAK-138) rather than silently running comps on a guessed address.
        const resolution = await this.resolveAddressTarget(plan, phone);
        if (resolution.kind === "ask") {
            return this.askWhichAddress({
                input,
                route,
                customer,
                phone,
                intent: "comps",
                compParams: plan.compParams ?? null,
                addresses: resolution.addresses,
                outOfRange: resolution.outOfRange,
                requested: resolution.requested,
            });
        }
        const target =
            resolution.kind === "resolved" ? resolution.target : await this.memory.lastResolvedAddress(phone);
        if (!target) {
            const reply = [
                "Text me a property address first, then I can pull comparable sales for it.",
                PropertyReportWriter.FOOTER,
            ].join("\n\n");
            await this.sendAndRemember(route, input.contactId, customer, phone, reply);
            await this.writeStatusNote(
                route,
                input.contactId,
                "Jake (text): comps asked with no address to run — sent guidance, no charge."
            );
            return { ok: true, address: null, reply, mode: route.mode, charged: 0 };
        }

        // Resolve parameters: admin defaults overlaid with texter overrides, clamped.
        const params = resolveCompParams(await this.compsSettings.defaultParams(), plan.compParams);
        const cost = await this.compsSettings.costOfComps();

        // Free re-serve: a repeat of the same target AND parameter-set in the window.
        const cached = await this.comps.checkCache(phone, target, params);
        if (cached) {
            return this.reserveCompsFromCache({ input, route, customer, phone, target, params, cached, cost });
        }

        // JAK-144: run immediately — NO "reply OK" confirmation. Credit gate FIRST:
        // insufficient balance → do NOT run, reply with the clear no-charge message.
        if (!(await this.credits.hasCreditsForComps(accountId, cost))) {
            const balance = await this.credits.getBalance(accountId);
            const reply = [
                `Pulling comparable sales for ${target} costs ${cost} credit${cost === 1 ? "" : "s"}, but you have ${balance}. ` +
                    "Top up and text me again to run it — I haven't charged you anything.",
                PropertyReportWriter.FOOTER,
            ].join("\n\n");
            await this.sendAndRemember(route, input.contactId, customer, phone, reply);
            await this.writeStatusNote(
                route,
                input.contactId,
                `Jake (text): comps for "${target}" needs ${cost} credit(s), balance ${balance} — declined, no charge.`
            );
            return { ok: false, address: target, reply, mode: route.mode, charged: 0, outOfCredits: true };
        }

        // Sufficient balance → pull comps right now. Charged ONLY when at least one
        // comparable sale was delivered (no charge on failure / no data).
        return this.runComps({
            input,
            route,
            customer,
            accountId,
            phone,
            target,
            params,
            credits: cost,
            requestingMessageId: ctx.requestingMessageId,
        });
    }

    /**
     * Free re-serve (JAK-137 / JAK-144) of a comps pull: a repeat of the same target
     * AND parameter-set within the free window. Return the STORED reply verbatim — no
     * paid API call, no LLM call, no credit — with an appended line noting it's
     * already on record and free. No "reply OK" prompt (JAK-144 removed
     * confirm-before-spend). The GoTextJake.com footer stays last.
     */
    private async reserveCompsFromCache(ctx: {
        input: JakeInboundMessage;
        route: TextRoute;
        customer: TextJakeCustomer;
        phone: string;
        target: string;
        params: CompParams;
        cached: CompsRow;
        cost: number;
    }): Promise<JakeInboundResult> {
        const { input, route, customer, phone, target, cached } = ctx;
        const reply = this.withCompsReserveNotice(cached.report_text);
        await this.sendAndRemember(route, input.contactId, customer, phone, reply);
        await this.writeStatusNote(
            route,
            input.contactId,
            `Jake (text): re-served cached comps for "${target}" for FREE — no charge, no API call.`
        );
        return { ok: true, address: target, reply, mode: route.mode, charged: 0, reserved: true };
    }

    /**
     * Run a comps pull (JAK-137 / JAK-144) — reached directly from handleComps once
     * the credit gate passes (NO "reply OK" step anymore). Calls the paid comps
     * lookup (mock/no-spend off prod) with the resolved parameters and charges the
     * cost ONLY when at least one comparable sale was delivered — the "no data, no
     * charge" safety is preserved. On a hit it snapshots the result (keyed per target
     * + parameter-set) so a repeat within the free window re-serves for free. The
     * caller has already verified the balance, so this does not re-gate.
     */
    private async runComps(ctx: {
        input: JakeInboundMessage;
        route: TextRoute;
        customer: TextJakeCustomer;
        accountId: string;
        phone: string;
        target: string;
        params: CompParams;
        credits: number;
        requestingMessageId: string | null;
    }): Promise<JakeInboundResult> {
        const { input, route, customer, accountId, phone, target, params, credits } = ctx;

        // The paid comps pull + the LLM writer can take a moment; ack now and deliver
        // the result in a follow-up so the texter isn't left waiting silently (JAK-138).
        await this.sendAck(route, input.contactId);

        let response: RealEstateApiPropertyCompsResponse | null;
        try {
            response = await this.realEstateDao.getCompsByAddress(target, params);
        } catch (err) {
            const reply = `Sorry — I hit a snag pulling comps for "${target}". Please try again shortly.`;
            await this.sendAndRemember(route, input.contactId, customer, phone, reply);
            await this.writeStatusNote(
                route,
                input.contactId,
                `Jake (text): comps FAILED for "${target}" (${this.errorSummary(err)}) — no charge.`
            );
            return { ok: false, address: target, reply, mode: route.mode, charged: 0 };
        }

        const data = assembleCompsData(response, target, params);
        if (!response || !hasComps(data)) {
            const reply = [
                `I couldn't find comparable sales for ${target} using ${formatCompParams(params)}, so I haven't charged you.`,
                PropertyReportWriter.FOOTER,
            ].join("\n\n");
            await this.sendAndRemember(route, input.contactId, customer, phone, reply);
            await this.writeStatusNote(
                route,
                input.contactId,
                `Jake (text): no comparable sales for "${target}" [${formatCompParams(params)}] — no charge.`
            );
            return { ok: true, address: target, reply, mode: route.mode, charged: 0 };
        }

        const reply = await this.compsWriter.write(data);
        await this.sendAndRemember(route, input.contactId, customer, phone, reply);

        const charge = await this.credits.chargeForComps({ accountId, credits });
        const charged = charge.ok ? credits : 0;
        await this.rememberComps({
            customer,
            phone,
            requestingMessageId: ctx.requestingMessageId,
            target,
            params,
            record: response,
            reportText: reply,
        });

        await this.writeStatusNote(
            route,
            input.contactId,
            `Jake (text): pulled comps for "${target}" [${formatCompParams(params)}] — charged ${charged} credit(s).`
        );
        return { ok: true, address: target, reply, mode: route.mode, charged, refreshed: undefined };
    }

    /**
     * Append the comps free-re-serve notice to a stored reply, KEEPING the
     * GoTextJake.com footer last (mirrors {@link withSkipTraceReserveNotice}).
     */
    private withCompsReserveNotice(reportText: string): string {
        const notice = "These comps are already on record, so this copy is free.";
        const footer = PropertyReportWriter.FOOTER;
        const trimmed = reportText.trimEnd();
        const body = trimmed.endsWith(footer)
            ? trimmed.slice(0, trimmed.length - footer.length).trimEnd()
            : trimmed;
        return `${body}\n\n${notice}\n\n${footer}`;
    }

    /** Clear a phone's outstanding comps offer (best-effort; never blocks the reply). */
    private async clearCompsPending(phone: string): Promise<void> {
        try {
            await this.comps.clearPending(phone);
        } catch (err) {
            console.error("⚠️ Jake comps pending clear failed:", this.errorSummary(err));
        }
    }

    /** Snapshot a paid comps pull for the free re-serve rule (best-effort memory). */
    private async rememberComps(input: {
        customer: TextJakeCustomer;
        phone: string;
        requestingMessageId: string | null;
        target: string;
        params: CompParams;
        record: RealEstateApiPropertyCompsResponse;
        reportText: string;
    }): Promise<void> {
        try {
            await this.comps.recordComps({
                customerId: input.customer.id,
                phone: input.phone,
                messageId: input.requestingMessageId,
                normalizedTarget: input.target,
                params: input.params,
                compsRecord: input.record,
                reportText: input.reportText,
            });
        } catch (err) {
            console.error("⚠️ Jake comps snapshot failed:", this.errorSummary(err));
        }
    }

    // ── Disambiguation (JAK-138) ─────────────────────────────────────────────

    /**
     * Resolve the concrete address an address-based intent acts on, or decide Jake
     * must ASK (JAK-138). Returns:
     *   - `resolved` when the router already pinned a target;
     *   - `ask` when the reference is AMBIGUOUS (2+ addresses on file, no clear pick)
     *     or OUT OF RANGE (an ordinal past the list) — Jake lists them and asks;
     *   - `none` when there's nothing to disambiguate (0–1 addresses, no bad ordinal),
     *     so the caller uses its own single-address fallback or guidance.
     */
    private async resolveAddressTarget(
        plan: DispatchPlan,
        phone: string
    ): Promise<
        | { kind: "resolved"; target: string }
        | { kind: "ask"; addresses: string[]; outOfRange: boolean; requested: number | null }
        | { kind: "none" }
    > {
        if (plan.targetEntity) return { kind: "resolved", target: plan.targetEntity };
        const addresses = (await this.memory.resolvedAddressList(phone)) ?? [];
        const ordinal = plan.addressOrdinal ?? null;
        const outOfRange = ordinal != null && ordinal > addresses.length;
        if (addresses.length >= 2 || (outOfRange && addresses.length >= 1)) {
            return { kind: "ask", addresses, outOfRange, requested: ordinal };
        }
        return { kind: "none" };
    }

    /**
     * Ask WHICH address the texter meant (JAK-138): reply with a short NUMBERED list
     * and park a pending question so a following bare number/ordinal runs `intent` on
     * the pick. Clears any outstanding paid quote first — we're asking a question,
     * not confirming a spend — so a later "OK" can't fire a stale action. Emoji-free,
     * footer last. No charge.
     */
    private async askWhichAddress(ctx: {
        input: JakeInboundMessage;
        route: TextRoute;
        customer: TextJakeCustomer;
        phone: string;
        intent: JakeIntent;
        compParams: CompParamOverrides | null;
        addresses: string[];
        outOfRange: boolean;
        requested: number | null;
    }): Promise<JakeInboundResult> {
        const { input, route, customer, phone, intent, compParams, addresses, outOfRange, requested } = ctx;
        await this.clearSkipTracePending(phone);
        await this.clearCompsPending(phone);
        await this.setDisambiguationPending(phone, customer.id, intent, compParams);

        const numbered = addresses.map((a, i) => `${i + 1}. ${a}`).join("\n");
        const lead =
            outOfRange && requested != null
                ? `You've sent me ${addresses.length} address${addresses.length === 1 ? "" : "es"} so far, not ${requested}. Here ${
                      addresses.length === 1 ? "it is" : "they are"
                  }:`
                : "I've got a few addresses on file — which one did you mean?";
        const reply = [`${lead}\n${numbered}`, "Reply with the number.", PropertyReportWriter.FOOTER].join("\n\n");
        await this.sendAndRemember(route, input.contactId, customer, phone, reply);
        await this.writeStatusNote(
            route,
            input.contactId,
            `Jake (text): asked to disambiguate ${intent} across ${addresses.length} address(es) — no charge.`
        );
        return { ok: true, address: null, reply, mode: route.mode, charged: 0 };
    }

    /**
     * Run the intent that was waiting on an address pick (JAK-138). Re-derives the
     * address from the CURRENT resolved-address list (stable + ordered) so the ordinal
     * still points where it did when the list was shown; a pick that's STILL out of
     * range re-asks. On a valid pick it clears the question and dispatches the stored
     * intent on the chosen address.
     */
    private async runDisambiguated(ctx: {
        input: JakeInboundMessage;
        route: TextRoute;
        customer: TextJakeCustomer;
        accountId: string;
        phone: string;
        requestingMessageId: string | null;
        pending: DisambiguationPendingRow;
        selection: OrdinalSelection;
    }): Promise<JakeInboundResult> {
        const { input, route, customer, accountId, phone, requestingMessageId, pending, selection } = ctx;
        const addresses = (await this.memory.resolvedAddressList(phone)) ?? [];
        const index = selection === "last" ? addresses.length : selection;

        if (index < 1 || index > addresses.length) {
            // The pick still points past the list — ask again, keeping the question.
            return this.askWhichAddress({
                input,
                route,
                customer,
                phone,
                intent: pending.intent,
                compParams: pending.comp_params,
                addresses,
                outOfRange: true,
                requested: typeof selection === "number" ? selection : null,
            });
        }

        const target = addresses[index - 1];
        await this.clearDisambiguationPending(phone);
        const resolvedPlan: DispatchPlan = {
            intent: pending.intent,
            targetEntity: target,
            specialists: [],
            userFacingNote: "",
            compParams: pending.comp_params,
            addressOrdinal: null,
        };

        if (pending.intent === "skip_trace") {
            return this.handleSkipTrace({ input, route, customer, accountId, phone, plan: resolvedPlan, requestingMessageId });
        }
        if (pending.intent === "comps") {
            return this.handleComps({ input, route, customer, accountId, phone, plan: resolvedPlan, requestingMessageId });
        }
        // property_report (and any other address intent): run the JAK-134 report path.
        await this.clearSkipTracePending(phone);
        await this.clearCompsPending(phone);
        const cached = await this.memory.checkCache(phone, target);
        if (cached) {
            return this.reserveFromCache({ input, route, customer, phone, address: target, cached });
        }
        return this.freshLookup({
            input,
            route,
            customer,
            accountId,
            phone,
            address: target,
            requestingMessageId,
            onOkRefresh: false,
        });
    }

    /**
     * Resolve an explicit PERSON reference into the last skip-trace result (JAK-138):
     * "the 3rd person", "that owner". Returns a handled result, or null to fall
     * through to normal address handling when the message isn't a person pick or
     * there's no prior trace with entities. An ambiguous pick (several people, no
     * clear index) lists them and asks; an unambiguous one re-serves that trace's
     * stored contact info for free.
     */
    private async resolveSkipTracePerson(ctx: {
        input: JakeInboundMessage;
        route: TextRoute;
        customer: TextJakeCustomer;
        phone: string;
    }): Promise<JakeInboundResult | null> {
        const { input, route, customer, phone } = ctx;
        const ref = parsePersonReference(input.message);
        if (!ref.matched) return null;

        const last = await this.skipTrace.latestTraceForPhone(phone);
        if (!last) return null;
        const people = this.skipTracePeople(last.trace_record);
        if (people.length === 0) return null;

        const inRange = ref.ordinal != null && ref.ordinal >= 1 && ref.ordinal <= people.length;
        const unambiguous = inRange || (ref.ordinal == null && people.length === 1);
        if (!unambiguous) {
            return this.askWhichPerson({ input, route, customer, phone, people, requested: ref.ordinal });
        }

        // Resolves to one person → re-serve that trace's stored contact info FREE
        // (already on record), parking a pending offer so an OK runs a fresh trace.
        const cost = await this.skipTraceSettings.costOfSkipTrace();
        return this.reserveSkipTraceFromCache({
            input,
            route,
            customer,
            phone,
            target: last.normalized_target,
            cached: last,
            cost,
        });
    }

    /**
     * Ask WHICH person the texter meant from a prior skip-trace (JAK-138): list the
     * people that trace turned up and ask them to reply with the name or the property
     * address. A person pick isn't an address pick, so any pending address question is
     * cleared. Emoji-free, footer last. No charge.
     */
    private async askWhichPerson(ctx: {
        input: JakeInboundMessage;
        route: TextRoute;
        customer: TextJakeCustomer;
        phone: string;
        people: string[];
        requested: number | null;
    }): Promise<JakeInboundResult> {
        const { input, route, customer, phone, people, requested } = ctx;
        await this.clearDisambiguationPending(phone);
        const numbered = people.map((p, i) => `${i + 1}. ${p}`).join("\n");
        const lead =
            requested != null
                ? `That trace turned up ${people.length} ${people.length === 1 ? "name" : "names"}, not ${requested}. Here ${
                      people.length === 1 ? "it is" : "they are"
                  }:`
                : "That trace turned up more than one person — who did you mean?";
        const reply = [
            `${lead}\n${numbered}`,
            "Reply with the name or the property address.",
            PropertyReportWriter.FOOTER,
        ].join("\n\n");
        await this.sendAndRemember(route, input.contactId, customer, phone, reply);
        await this.writeStatusNote(
            route,
            input.contactId,
            `Jake (text): asked to disambiguate a person reference (${people.length} on record) — no charge.`
        );
        return { ok: true, address: null, reply, mode: route.mode, charged: 0 };
    }

    /**
     * The distinct person names a stored skip-trace result turned up — the primary
     * owner plus any additional identity names — for a JAK-138 person reference.
     * De-duplicated; never fabricates a name.
     */
    private skipTracePeople(record: unknown): string[] {
        const rec = (record ?? null) as RealEstateApiSkipTraceResult | null;
        if (!rec) return [];
        const persons = rec.persons ?? [];
        const identity = rec.output?.identity ?? null;
        const names: string[] = [];
        const primary = this.skipTraceOwnerName(rec, identity, persons);
        if (primary) names.push(primary);
        // JAK-144: each additional matched person (live `persons[]` shape) is a
        // distinct name the texter could mean.
        for (const p of persons) {
            const full =
                this.text(p.fullName) ??
                this.text(p.name) ??
                [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
            if (full) names.push(full);
        }
        for (const n of identity?.names ?? []) {
            if (typeof n === "string") {
                const t = this.text(n);
                if (t) names.push(t);
            } else if (n && typeof n === "object") {
                const full = this.text(n.fullName) ?? [n.firstName, n.lastName].filter(Boolean).join(" ").trim();
                if (full) names.push(full);
            }
        }
        return this.dedupe(names);
    }

    /** Park the ONE outstanding disambiguation question for a phone (best-effort). */
    private async setDisambiguationPending(
        phone: string,
        customerId: string,
        intent: JakeIntent,
        compParams: CompParamOverrides | null
    ): Promise<void> {
        try {
            await this.disambiguation.setPending({ phone, customerId, intent, compParams });
        } catch (err) {
            console.error("⚠️ Jake disambiguation pending set failed:", this.errorSummary(err));
        }
    }

    /** Clear a phone's outstanding disambiguation question (best-effort; never blocks). */
    private async clearDisambiguationPending(phone: string): Promise<void> {
        try {
            await this.disambiguation.clearPending(phone);
        } catch (err) {
            console.error("⚠️ Jake disambiguation pending clear failed:", this.errorSummary(err));
        }
    }

    /** Send the brief "working on it" ack before a slow paid run (best-effort; never blocks). */
    private async sendAck(route: TextRoute, contactId: string): Promise<void> {
        try {
            await route.send(contactId, ACK_REPLY);
        } catch (err) {
            console.error("⚠️ Jake ack send failed:", this.errorSummary(err));
        }
    }

    /**
     * The help / capability menu (JAK-138) — sent for a greeting, an unrecognized
     * message, or an explicit "help". It plainly lists what Jake can do WITH each
     * action's live credit cost pulled from the current admin settings (never
     * hardcoded), so the numbers always match what the specialists actually charge.
     * Emoji-free, GoTextJake.com footer last. No lookup, no charge.
     */
    private async sendGuidance(
        input: JakeInboundMessage,
        route: TextRoute,
        customer: TextJakeCustomer,
        phone: string
    ): Promise<JakeInboundResult> {
        const reply = await this.buildHelpReply();
        await this.sendAndRemember(route, input.contactId, customer, phone, reply);
        await this.writeStatusNote(
            route,
            input.contactId,
            "Jake (text): sent the help / capability menu — no lookup, no charge."
        );
        return { ok: true, address: null, reply, mode: route.mode, charged: 0 };
    }

    /**
     * Compose the capability menu with LIVE costs read from the admin settings
     * (report = text-lookup cost, skip-trace = its cost knob, comps = its cost knob).
     * Costs are fetched fresh here so an admin retune shows up immediately.
     */
    private async buildHelpReply(): Promise<string> {
        const [skipCost, compsCost] = await Promise.all([
            this.skipTraceSettings.costOfSkipTrace(),
            this.compsSettings.costOfComps(),
        ]);
        const reportCost = this.credits.costOfTextLookup();
        const credit = (n: number) => `${n} credit${n === 1 ? "" : "s"}`;
        return [
            "Hi! I'm Jake. Here's what I can do — just text a full property address to start:",
            [
                `- Property report (${credit(reportCost)}) — owner, value, equity, and distress signals.`,
                `- Find the owner / skip trace (${credit(skipCost)}) — their phone and contact info.`,
                `- Comparable sales / comps (${credit(compsCost)}) — recent nearby sales for a property.`,
            ].join("\n"),
            'You can refer back to an address you already sent ("the 2nd one", "the last address").',
            PropertyReportWriter.FOOTER,
        ].join("\n\n");
    }

    /** Send a reply and record it as an outbound message (best-effort memory). */
    private async sendAndRemember(
        route: TextRoute,
        contactId: string,
        customer: TextJakeCustomer,
        phone: string,
        reply: string
    ): Promise<void> {
        await route.send(contactId, reply);
        try {
            await this.memory.appendOutbound({
                customerId: customer.id,
                phone,
                body: reply,
                tenantLocationId: route.locationId ?? null,
                textMode: route.mode,
            });
        } catch (err) {
            console.error("⚠️ Jake outbound memory write failed:", this.errorSummary(err));
        }
    }

    /**
     * Persist the inbound message (best-effort). Returns the new message id so a
     * resulting lookup snapshot can link back to it, or null if the memory write
     * failed — a memory hiccup must never block the customer's reply.
     */
    private async rememberInbound(
        customer: TextJakeCustomer,
        phone: string,
        body: string,
        resolvedAddress: string | null,
        route: TextRoute
    ): Promise<string | null> {
        try {
            const row = await this.memory.appendInbound({
                customerId: customer.id,
                phone,
                body,
                resolvedAddress,
                tenantLocationId: route.locationId ?? null,
                textMode: route.mode,
            });
            return row.id;
        } catch (err) {
            console.error("⚠️ Jake inbound memory write failed:", this.errorSummary(err));
            return null;
        }
    }

    /** Snapshot a paid lookup for the free re-serve rule (best-effort memory). */
    private async rememberLookup(input: {
        customer: TextJakeCustomer;
        phone: string;
        requestingMessageId: string | null;
        address: string;
        property: RealEstateApiPropertySearchResult;
        reportText: string;
    }): Promise<void> {
        try {
            await this.memory.recordLookup({
                customerId: input.customer.id,
                phone: input.phone,
                messageId: input.requestingMessageId,
                normalizedAddress: input.address,
                propertyId: this.propertyId(input.property),
                propertyRecord: input.property,
                reportText: input.reportText,
            });
        } catch (err) {
            console.error("⚠️ Jake lookup snapshot failed:", this.errorSummary(err));
        }
    }

    /**
     * Append the free-re-serve notice to a stored report, KEEPING the mandatory
     * GoTextJake.com footer last. The notice sits just above the footer so the
     * message still ends with the exact two footer lines (JAK-131 guardrail).
     */
    private withReserveNotice(reportText: string, cost: number): string {
        const notice =
            "This address is already on record, so this copy is free. " +
            `Reply OK for a fresh copy (costs ${cost} credit${cost === 1 ? "" : "s"}).`;
        const footer = PropertyReportWriter.FOOTER;
        const trimmed = reportText.trimEnd();
        const body = trimmed.endsWith(footer)
            ? trimmed.slice(0, trimmed.length - footer.length).trimEnd()
            : trimmed;
        return `${body}\n\n${notice}\n\n${footer}`;
    }

    /**
     * Whether a message is a bare affirmative — the reply that requests a fresh paid
     * copy (report_refresh) of the last address. Since JAK-144 removed
     * confirm-before-spend for skip-trace / comps, a bare OK no longer confirms a
     * pending quote; it only routes report_refresh. A bare OK / OKAY / YES / YEAH /
     * YEP / Y / SURE (case-insensitive) matches; anything else does not. Kept tight
     * (a single bare token) so a real address or question is never mistaken for one.
     */
    private isAffirmativeOk(message: string): boolean {
        const compact = String(message).trim().toLowerCase().replace(/[^a-z]/g, "");
        return JakeAssistantService.AFFIRMATIVES.has(compact);
    }

    /** The provider's record id as a string, or null when absent. */
    private propertyId(property: RealEstateApiPropertySearchResult): string | null {
        return property.id != null ? String(property.id) : null;
    }

    /**
     * Resolve the transport for this inbound. own_number when an ACTIVE connection
     * owns the message (by location id or destination number) AND is set to
     * text_mode='own_number'; gateway otherwise (the default — including tier-1
     * customers with no connection at all). Never falls back to another tenant's
     * creds: a non-own_number/unknown/inactive connection uses the shared gateway.
     */
    private async resolveRoute(input: JakeInboundMessage): Promise<TextRoute> {
        const conn = await this.resolveOwnNumberConnection(input);
        if (conn) {
            // Only reply from a number PROVEN to belong to this connection; else
            // omit it so GHL uses the location default (never an attacker-supplied
            // number). This is the JAK-114 reply-from safety, preserved.
            const replyFrom = (input.candidateNumbers ?? [])
                .map((n) => (n ? String(n).trim() : ""))
                .find((n) => n.length > 0 && conn.phoneNumbers.includes(n));
            return {
                mode: "own_number",
                locationId: conn.locationId,
                send: (contactId, message) =>
                    this.ghlClient.sendSms(conn.locationId, {
                        contactId,
                        message,
                        fromNumber: replyFrom || undefined,
                    }),
                note: (contactId, body) => this.ghlClient.createNote(conn.locationId, contactId, body),
            };
        }

        return {
            mode: "gateway",
            send: (contactId, message) => this.gateway.sendSms({ contactId, message }),
            note: (contactId, body) => this.gateway.createContactNote(contactId, body),
        };
    }

    /**
     * Find the connection that should handle this text in own_number mode, or null
     * to fall through to the gateway. Prefers the explicit location id, then a
     * destination number match. Returns null unless the connection is active AND
     * opted into own_number.
     */
    private async resolveOwnNumberConnection(
        input: JakeInboundMessage
    ): Promise<GhlConnection | null> {
        let conn: GhlConnection | null = null;

        const loc = input.locationId ? String(input.locationId).trim() : "";
        if (loc) {
            conn = await this.connections.getByLocationId(loc);
        }
        if (!conn) {
            for (const raw of input.candidateNumbers ?? []) {
                const num = raw ? String(raw).trim() : "";
                if (!num) continue;
                conn = await this.connections.getByPhoneNumber(num);
                if (conn) break;
            }
        }

        if (!conn) return null;
        if (conn.status !== "active") return null;
        if (conn.textMode !== "own_number") return null;
        return conn;
    }

    /**
     * Write a status note, swallowing failures: a note is best-effort telemetry on
     * the contact — it must never break the reply the customer already received.
     */
    private async writeStatusNote(route: TextRoute, contactId: string, body: string): Promise<void> {
        try {
            await route.note(contactId, body);
        } catch (err) {
            console.error("⚠️ Jake status note failed:", this.errorSummary(err));
        }
    }

    /** A short, secret-free description of an error for logs/notes. */
    private errorSummary(err: unknown): string {
        return err instanceof Error ? err.message : "unknown error";
    }

    /**
     * Build the customer's reply (JAK-130). No match → a deterministic, emoji-free
     * "try again" line (never the LLM). Otherwise: assemble the VERIFIED property
     * data (only fields the API returned + our derived ones) and hand it to the
     * {@link PropertyReportWriter}, which has the LLM write a "Jake Property Report"
     * SMS — falling back to a deterministic plain-text report if OpenAI is down.
     */
    private async buildReply(
        address: string,
        property: RealEstateApiPropertySearchResult | null
    ): Promise<string> {
        if (!property) {
            return `I couldn't find property info for "${address}". Double-check the address and try again.`;
        }
        // The LLM path gets the COMPLETE PropertySearch record (raw `property`) so
        // it can dynamically surface money + distress signals we don't curate; the
        // deterministic fallback still runs off the assembled, verified subset.
        return this.reportWriter.write(this.assembleReportData(property, address), property);
    }

    /**
     * Map a raw PropertySearch summary into the clean, verified {@link PropertyReportData}
     * the writer consumes. Only present values are set (missing → left undefined,
     * never null/blank), and the derived fields (lot acres, equity level, occupancy,
     * absentee status, years owned, free-&-clear) are computed here from the raw
     * data per JAK-130's derivation rules.
     */
    private assembleReportData(
        property: RealEstateApiPropertySearchResult,
        address: string
    ): PropertyReportData {
        const data: PropertyReportData = {};

        const { street, tail } = this.addressParts(property);
        if (street) data.addressLine1 = street;
        if (tail) data.addressLine2 = tail;
        if (!street && !tail && address.trim()) data.addressLine1 = address.trim();

        const propertyType = this.text(property.propertyType);
        if (propertyType) data.propertyType = propertyType;
        if (property.bedrooms != null) data.bedrooms = property.bedrooms;
        if (property.bathrooms != null) data.bathrooms = property.bathrooms;
        if (property.squareFeet != null) data.squareFeet = property.squareFeet;
        const lot = property.lotSquareFeet;
        if (lot != null && lot > 0) data.lotAcres = Number((lot / 43560).toFixed(2));
        if (property.yearBuilt != null) data.yearBuilt = property.yearBuilt;

        if (property.estimatedValue != null) data.estimatedMarketValue = property.estimatedValue;

        const owner1 = this.owner1Name(property);
        if (owner1) data.owner1 = owner1;
        const owner2 = this.owner2Name(property);
        if (owner2) data.owner2 = owner2;
        const equityPercent = this.equityPercent(property);
        if (equityPercent != null) data.equityPercent = equityPercent;
        if (this.isFreeClear(property)) data.freeAndClear = true;
        const equityLevel = this.equityLevel(property);
        if (equityLevel) data.equityLevel = equityLevel;
        const occupancy = this.occupancy(property);
        if (occupancy) data.occupancy = occupancy;
        const absentee = this.absentee(property);
        if (absentee) data.absenteeStatus = absentee;
        const yearsOwned = this.yearsOwned(property);
        if (yearsOwned != null) data.yearsOwned = yearsOwned;

        // Financials (JAK-132): estimated dollar figures from the SAME call.
        if (property.openMortgageBalance != null) data.estimatedMortgageBalance = property.openMortgageBalance;
        if (property.estimatedMortgagePayment != null) data.estimatedMortgagePayment = property.estimatedMortgagePayment;
        if (property.estimatedEquity != null) data.estimatedEquity = property.estimatedEquity;

        // Distress / liens (JAK-132): Yes/No flags only. Copy the boolean when the
        // API actually returned one (true OR false) so the fallback can tell
        // "checked, none on record" from "unknown". Never a dollar amount.
        if (typeof property.foreclosure === "boolean") data.foreclosure = property.foreclosure;
        if (typeof property.preForeclosure === "boolean") data.preForeclosure = property.preForeclosure;
        if (typeof property.reo === "boolean") data.reo = property.reo;
        if (typeof property.auction === "boolean") data.auction = property.auction;
        const auctionDate = this.text(property.auctionDate);
        if (auctionDate) data.auctionDate = this.formatDate(auctionDate);
        if (typeof property.taxLien === "boolean") data.taxLien = property.taxLien;
        if (typeof property.judgment === "boolean") data.judgment = property.judgment;

        if (property.lastSaleDate) data.lastSoldDate = this.formatDate(property.lastSaleDate);
        if (property.lastSaleAmount != null) data.salePrice = property.lastSaleAmount;

        const flood = this.text(property.floodZoneDescription);
        if (flood) data.femaFloodZone = flood;
        if (typeof property.mlsActive === "boolean") data.mlsListed = property.mlsActive;

        return data;
    }

    private addressParts(property: RealEstateApiPropertySearchResult): { street: string; tail: string } {
        const a = property.address;
        const loc = this.propertyLocation(property);
        let street = "";
        let tail = this.cityStateZip(loc.city, loc.state, loc.zip);

        if (typeof a === "string") {
            const s = a.trim();
            const idx = s.indexOf(",");
            if (idx >= 0) {
                street = s.slice(0, idx).trim();
                if (!tail) tail = s.slice(idx + 1).trim().replace(/\s+/g, " ");
            } else {
                street = s;
            }
        } else if (a && typeof a === "object") {
            street = [a.house, a.street, a.streetType].filter(Boolean).join(" ").trim();
        }

        return { street, tail };
    }

    /** Resolve city/state/zip from flat fields, falling back to the address object. */
    private propertyLocation(
        property: RealEstateApiPropertySearchResult
    ): { city?: string; state?: string; zip?: string } {
        const obj = property.address && typeof property.address === "object" ? property.address : null;
        const pick = (flat?: string | null, nested?: string | null) =>
            (flat ?? nested ?? "").toString().trim() || undefined;
        return {
            city: pick(property.city, obj?.city),
            state: pick(property.state, obj?.state),
            zip: pick(property.zip, obj?.zip),
        };
    }

    private cityStateZip(city?: string, state?: string, zip?: string): string {
        const left = (city ?? "").trim();
        const right = [state, zip].map((x) => (x ?? "").trim()).filter(Boolean).join(" ");
        return [left, right].filter(Boolean).join(", ");
    }

    private owner1Name(property: RealEstateApiPropertySearchResult): string | null {
        if (property.owner1FullName?.trim()) return property.owner1FullName.trim();
        const composed = [property.owner1FirstName, property.owner1LastName].filter(Boolean).join(" ").trim();
        return composed || null;
    }

    private owner2Name(property: RealEstateApiPropertySearchResult): string | null {
        if (property.owner2FullName?.trim()) return property.owner2FullName.trim();
        const composed = [property.owner2FirstName, property.owner2LastName].filter(Boolean).join(" ").trim();
        return composed || null;
    }

    private equityPercent(property: RealEstateApiPropertySearchResult): number | null {
        if (typeof property.equityPercent === "number") return Math.round(property.equityPercent);
        if (this.isFreeClear(property)) return 100; // free & clear implies full equity
        return null;
    }

    /** Free & Clear = no open mortgage (prefer the flag, else a zero balance). */
    private isFreeClear(property: RealEstateApiPropertySearchResult): boolean {
        if (typeof property.freeClear === "boolean") return property.freeClear;
        if (typeof property.openMortgageBalance === "number") return property.openMortgageBalance === 0;
        return false;
    }

    private equityLevel(property: RealEstateApiPropertySearchResult): EquityLevel | null {
        if (typeof property.highEquity === "boolean") return property.highEquity ? "High Equity" : "Low Equity";
        const pct = this.equityPercent(property);
        if (pct == null) return null;
        return pct >= 50 ? "High Equity" : "Low Equity";
    }

    /**
     * Owner-Occupied vs Investor-Owned — prefer the provider flag, else derive
     * from whether the owner's tax-mailing address matches the property.
     */
    private occupancy(property: RealEstateApiPropertySearchResult): OccupancyStatus | null {
        if (typeof property.ownerOccupied === "boolean") {
            return property.ownerOccupied ? "Owner-Occupied" : "Investor-Owned";
        }
        const match = this.mailingMatchesProperty(property);
        if (match == null) return null;
        return match ? "Owner-Occupied" : "Investor-Owned";
    }

    /**
     * Absentee status derived from owner mailing vs property location: a different
     * state ⇒ Out-of-State Absentee Owner, a different city ⇒ Absentee Owner.
     * Falls back to provider flags when no mailing address is available.
     */
    private absentee(property: RealEstateApiPropertySearchResult): AbsenteeStatus | null {
        const mail = property.mailAddress;
        const loc = this.propertyLocation(property);
        const norm = (s?: string | null) => (s ?? "").toString().trim().toUpperCase();

        if (mail && (mail.state || mail.city)) {
            const mState = norm(mail.state);
            const mCity = norm(mail.city);
            if (loc.state && mState && mState !== norm(loc.state)) return "Out-of-State Absentee Owner";
            if (loc.city && mCity && mCity !== norm(loc.city)) return "Absentee Owner";
            return null;
        }

        if (property.outOfStateAbsenteeOwner === true) return "Out-of-State Absentee Owner";
        if (property.absenteeOwner === true || property.inStateAbsenteeOwner === true) return "Absentee Owner";
        return null;
    }

    private mailingMatchesProperty(property: RealEstateApiPropertySearchResult): boolean | null {
        const mail = property.mailAddress;
        if (!mail || (!mail.state && !mail.city)) return null;
        const loc = this.propertyLocation(property);
        if (!loc.state && !loc.city) return null;
        const norm = (s?: string | null) => (s ?? "").toString().trim().toUpperCase();
        const sameState = mail.state && loc.state ? norm(mail.state) === norm(loc.state) : true;
        const sameCity = mail.city && loc.city ? norm(mail.city) === norm(loc.city) : true;
        return sameState && sameCity;
    }

    /** Prefer the provider's yearsOwned, else current year minus the last-sale year. */
    private yearsOwned(property: RealEstateApiPropertySearchResult): number | null {
        if (typeof property.yearsOwned === "number" && property.yearsOwned >= 0) {
            return property.yearsOwned;
        }
        const year = this.saleYear(property.lastSaleDate);
        if (year == null) return null;
        const diff = new Date().getFullYear() - year;
        return diff >= 0 ? diff : null;
    }

    /** Normalize an ISO (YYYY-MM-DD…) sale date to MM/DD/YYYY; pass others through. */
    private formatDate(raw: string): string {
        const s = raw.trim();
        const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        return iso ? `${iso[2]}/${iso[3]}/${iso[1]}` : s;
    }

    private saleYear(raw?: string | null): number | null {
        if (!raw) return null;
        const m = String(raw).match(/(\d{4})/);
        if (!m) return null;
        const y = Number(m[1]);
        return Number.isFinite(y) ? y : null;
    }

    private text(v: unknown): string | null {
        return typeof v === "string" && v.trim() ? v.trim() : null;
    }
}
