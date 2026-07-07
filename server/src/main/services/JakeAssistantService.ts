import { injectable } from "tsyringe";
import { RealEstateApiDao } from "../data/RealEstateApiDao.ts";
import { GhlApiClient } from "../ghlEnrichment/api/GhlApiClient.ts";
import { GhlConnectionService } from "../ghlEnrichment/connections/GhlConnectionService.ts";
import { GhlConnection } from "../ghlEnrichment/connections/GhlConnectionTypes.ts";
import { JakeGatewayClient } from "../ghlEnrichment/gateway/JakeGatewayClient.ts";
import { CreditService } from "../ghlEnrichment/metering/CreditService.ts";
import { CreditSettingsService } from "../ghlEnrichment/metering/CreditSettingsService.ts";
import { CreditType } from "../ghlEnrichment/metering/CreditCosts.ts";
import { TextJakeCustomerService } from "../ghlEnrichment/customers/TextJakeCustomerService.ts";
import { ConversationMemoryService } from "../ghlEnrichment/conversation/ConversationMemoryService.ts";
import { LookupRow } from "../ghlEnrichment/conversation/ConversationTypes.ts";
import { TextJakeCustomer } from "../ghlEnrichment/customers/TextJakeCustomerTypes.ts";
import { parseCommandAddress } from "../util/address.ts";
import { JakeInboundMessage, JakeInboundResult, JakeTextMode } from "../types/Jake.ts";
import {
    RealEstateApiAddress,
    RealEstateApiMailingAddress,
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
import {
    SkipTraceData,
    SkipTracePersonContact,
    SkipTraceRow,
    SkipTraceSubject,
    hasContactInfo,
    skipTraceSubjectKey,
} from "./skiptrace/SkipTraceTypes.ts";
import { CompsReportWriter } from "./comps/CompsReportWriter.ts";
import { CompsMemoryService } from "./comps/CompsMemoryService.ts";
import { CompsSettingsService } from "./comps/CompsSettingsService.ts";
import { CompsSelectionEngine } from "./comps/CompsSelectionEngine.ts";
import { OnboardingPromptService } from "./onboarding/OnboardingPromptService.ts";
import { buildCreditBalanceMessage } from "./creditStatusMessage.ts";
import {
    CapturedProfile,
    buildProfileAck,
    buildIntroMessage,
    parseProfileReply,
} from "./onboarding/onboardingMessages.ts";
import {
    CompParamOverrides,
    CompParams,
    CompsRow,
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

/**
 * The brief ACK Jake sends before a confirmed paid specialist (skip-trace / comps)
 * that hits a paid API + the LLM writer, so the texter isn't left waiting in
 * silence; the result follows in a second message (JAK-138 latency polish).
 */
const ACK_REPLY = "Working on it, one moment.";

/**
 * The exact hold-notice copy sent when a text customer is on hold (JAK-148) —
 * emoji-free, with the mandatory GoTextJake.com footer last. Kept as a single
 * editable constant. Sent for the SOFT on_hold state (GHL is still forwarding
 * their texts, so Jake must reply something) and as the deactivated backstop.
 * Jake does NO work and NO charge on either path.
 */
const ACCOUNT_ON_HOLD_REPLY = [
    "Your account is on hold. Please contact the admin to get this resolved.",
    PropertyReportWriter.FOOTER,
].join("\n\n");

@injectable()
export class JakeAssistantService {
    /**
     * The bare tokens that trigger the READ-ONLY credit-status reply
     * (JAK-credit-keyword): 'credit'/'credits', case-insensitive + trimmed. Kept
     * tight to exactly these two words (see {@link isCreditKeyword}) so an address
     * or a phrase like "credit balance" is never mistaken for the status command.
     */
    private static readonly CREDIT_KEYWORDS = new Set(["credit", "credits"]);

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
        private readonly creditSettings: CreditSettingsService,
        private readonly reportWriter: PropertyReportWriter,
        private readonly memory: ConversationMemoryService,
        private readonly orchestrator: JakeOrchestrator,
        private readonly skipTraceWriter: SkipTraceReportWriter,
        private readonly skipTrace: SkipTraceMemoryService,
        private readonly skipTraceSettings: SkipTraceSettingsService,
        private readonly compsWriter: CompsReportWriter,
        private readonly comps: CompsMemoryService,
        private readonly compsSettings: CompsSettingsService,
        private readonly disambiguation: DisambiguationMemoryService,
        private readonly compsEngine: CompsSelectionEngine,
        private readonly onboardingPrompt: OnboardingPromptService
    ) {}

    /**
     * How many delivered reports trigger the DELAYED onboarding email ask
     * (JAK-first-text-welcome): fired ONCE, right after this many reports.
     */
    private static readonly ONBOARDING_AFTER_REPORTS = 3;

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
        // 1. Billing identity — the texting customer, keyed by sender phone. The
        //    `created` flag tells us this is their FIRST-EVER text so we send the
        //    one-time welcome below (JAK-first-text-welcome).
        const { customer, created: firstContact } = await this.customers.resolveByPhoneWithCreation(
            input.senderPhone,
            input.contactId
        );
        const accountId = customer.creditAccountId;
        const phone = customer.phone;

        // 2. Mode + transport.
        const route = await this.resolveRoute(input);

        // JAK-148 two-level hold — enforced BEFORE any work (no orchestrator, no
        // specialist, no charge). Server-side only (JAK-remove-ghl-hold): the GHL
        // automation filter that used to gate on the "text Jake" field is gone, so
        // BOTH held states now reach Jake and are stopped here. on_hold: reply a
        // friendly hold notice. deactivated: refuse to process. NEITHER path
        // touches credits.
        if (customer.status !== "active") {
            return this.replyAccountHeld(input, route, customer, phone);
        }

        // JAK-156: parse the address whether it's bare ("123 Main St, Tampa FL") OR
        // typed INSIDE a command ("skip 123 Main St, Tampa FL", "comps 123 ..."). The
        // command-aware parser strips a leading command word before parsing, so an
        // explicitly-typed address is captured instead of being discarded and the
        // target silently resolved from OLD conversation history. A bare address with
        // no command word still parses exactly as before (the report path is intact).
        const address = parseCommandAddress(input.message);

        // 3. Persist EVERY inbound message in ordered per-phone memory (JAK-134),
        //    with the address we resolved from it (null when it wasn't one). A typed
        //    inline address is recorded here too, so it becomes the new MOST RECENT
        //    address (JAK-154) and enters the ordinal list for later references. The
        //    returned id links any resulting lookup snapshot back to this message.
        const inboundId = await this.rememberInbound(customer, phone, input.message, address, route);

        // JAK-credit-keyword: 'credit'/'credits' is a READ-ONLY status command, not
        // an address — recognized BEFORE the welcome + orchestrated dispatch paths so
        // it reports the customer's balances instead of being routed as a report
        // request. No charge, no deduction, no orchestrator call.
        if (this.isCreditKeyword(input.message)) {
            return this.replyCreditBalance({ input, route, customer, phone, firstContact });
        }

        // JAK-silent-credits-intro. First contact is CLEAN — credits are seeded
        // silently (at customer creation) and NEVER announced. On the FIRST-EVER text:
        //   - a GREETING / non-address → a simple intro (no credits, no menu) and STOP;
        //   - an ADDRESS → no intro at all, just fall through and return the report.
        // On a LATER text, once we've asked for their info, a follow-up reply that
        // provides a name/email is captured into their profile and answered — WITHOUT
        // blocking normal usage (an address/command falls through to the report path).
        // Returning customers with nothing pending are unaffected.
        //
        // JAK-onboarding-address-routing: the greeting-vs-address decision must NOT
        // key off the strict inline parser (`address` above), which returns null when
        // the address has PREAMBLE ("Hey Jake, look up this address 123 Main St") and
        // so misclassifies an address-containing first text as a greeting → wrong intro.
        // Instead we ATTEMPT ADDRESS RESOLUTION FIRST via the SAME orchestrator/LLM path
        // the report flow uses (it handles preamble); the intro fires ONLY when that
        // resolves NO address. Classify eagerly here so first contact can inspect the
        // plan and, when an address IS present, reuse the very same plan for the report.
        let plan: DispatchPlan | null = null;
        if (firstContact) {
            plan = await this.classify(input, phone, address);
            if (!this.planResolvesAddress(plan)) {
                const intro = await this.sendIntro(route, input, customer, phone);
                return { ok: true, address: null, reply: intro ?? "", mode: route.mode, charged: 0 };
            }
        } else {
            const captured = await this.tryCaptureProfile({ input, route, customer, phone, address });
            if (captured) return captured;
        }

        // 4. Classify intent + resolve references against memory (JAK-135). The
        //    router reads the recent window + the ordered resolved-address list and
        //    returns a typed plan; we dispatch on it below. (First contact already
        //    classified above to make the greeting-vs-address call; reuse that plan.)
        if (!plan) {
            plan = await this.classify(input, phone, address);
        }

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
     * Classify one inbound message into a dispatch plan (JAK-135) via the router
     * LLM. Factored out so BOTH the first-contact greeting-vs-address decision
     * (JAK-onboarding-address-routing) and the normal report dispatch resolve the
     * address through the exact SAME path — the lenient LLM resolver that handles
     * preamble the strict inline parser misses.
     */
    private classify(input: JakeInboundMessage, phone: string, parsedAddress: string | null): Promise<DispatchPlan> {
        return this.orchestrator.plan({
            phone,
            message: input.message,
            parsedAddress,
            isAffirmative: this.isAffirmativeOk(input.message),
        });
    }

    /**
     * JAK-onboarding-address-routing: does this plan resolve a concrete address to
     * act on? The orchestrator only sets `targetEntity` for address-acting intents
     * (property_report / skip_trace / comps) with a resolved target, so a genuine
     * greeting ("hey", "hi") leaves it null. Used by the first-contact decision so a
     * first message that CONTAINS an address — even behind preamble the strict inline
     * parser misses ("Hey Jake, look up 123 Main St") — runs the report instead of the
     * greeting intro.
     */
    private planResolvesAddress(plan: DispatchPlan): boolean {
        return plan.targetEntity != null;
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
                // JAK-166: this resolved address is now the conversation's active
                // property — backfill it onto the requesting message so a later bare
                // comps/skip targets THIS property, not a stale older one the
                // insert-time regex happened to capture.
                await this.rememberActiveProperty(requestingMessageId, target);
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
     * The customer-facing out-of-credits reply for one feature bucket (JAK-161):
     * the ADMIN-EDITABLE message for that bucket, with the canonical JAK-158 SMS
     * footer appended last (the footer is NOT part of the editable copy, so it can
     * never be edited away). Sent when the bucket can't cover the feature's cost —
     * the specialist does NOT run and nothing is charged.
     */
    private async outOfCreditsReply(type: CreditType): Promise<string> {
        const message = await this.creditSettings.outOfCreditsMessage(type);
        return [message, PropertyReportWriter.FOOTER].join("\n\n");
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

        // Credit gate — never look up for free. The REPORT bucket only (JAK-161):
        // an empty skip-trace / comps balance never blocks a report.
        if (!(await this.credits.hasCreditsForTextLookup(accountId))) {
            const reply = await this.outOfCreditsReply("report");
            await this.sendAndRemember(route, input.contactId, customer, phone, reply);
            await this.writeStatusNote(
                route,
                input.contactId,
                `Jake (text): out of report credits — skipped lookup for "${address}".`
            );
            return {
                ok: false,
                address,
                reply,
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

        // A delivered property report counts toward the delayed onboarding ask
        // (JAK-first-text-welcome). A no-match reply is NOT a report, so skip it.
        if (property) {
            await this.recordReportDelivered(route, input, customer, phone);
        }

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
        const reply = this.withReserveNotice(cached.report_text);
        await this.sendAndRemember(route, input.contactId, customer, phone, reply);
        await this.writeStatusNote(
            route,
            input.contactId,
            `Jake (text): re-served cached report for "${address}" for FREE — no charge, no API call.`
        );
        // A free re-serve is still a report the customer received, so it counts
        // toward the delayed onboarding ask (JAK-first-text-welcome).
        await this.recordReportDelivered(route, input, customer, phone);
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

        // Resolve the address to trace, or ASK when an EXPLICIT ordinal is out of
        // range (JAK-138). A BARE trace defaults to the MOST RECENT address (JAK-154)
        // — the last property the texter got a report on — never an older one.
        const resolution = await this.resolveAddressTarget(plan, phone, "most_recent");
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

        // JAK-166: the address this trace acts on becomes the active property, so a
        // following bare comps/skip stays on it (and an inline "skip 123 Main St"
        // makes 123 Main the active property).
        await this.rememberActiveProperty(ctx.requestingMessageId, target);

        // JAK-145: resolve WHO we trace — the texter-named people ("skip trace
        // Jane and John"), else the PROPERTY OWNER pulled from PropertySearch
        // (reusing the cached report's ownerInfo when we have it, so we don't pay for
        // a second lookup). The owner name + address go to the trace, and the cache is
        // keyed on (address + this person identity) so a request for a DIFFERENT
        // person at the same address is a NEW lookup, not a cached hit of the first.
        const subject = await this.resolveTraceSubject(phone, target, plan);
        const subjectKey = skipTraceSubjectKey(subject.names);

        const cost = await this.skipTraceSettings.costOfSkipTrace();

        // Free re-serve: a repeat trace of the same target AND person within the window.
        const cached = await this.skipTrace.checkCache(phone, target, subjectKey);
        if (cached) {
            return this.reserveSkipTraceFromCache({ input, route, customer, phone, target, cached, cost });
        }

        // JAK-144: run immediately — NO "reply OK" confirmation. Credit gate FIRST
        // on the SKIPTRACE bucket only (JAK-161): insufficient balance → do NOT run,
        // reply with the admin-editable skip-trace out-of-credits message, no charge.
        if (!(await this.credits.hasCreditsForSkipTrace(accountId, cost))) {
            const balance = await this.credits.getBalance(accountId, "skiptrace");
            const reply = await this.outOfCreditsReply("skiptrace");
            await this.sendAndRemember(route, input.contactId, customer, phone, reply);
            await this.writeStatusNote(
                route,
                input.contactId,
                `Jake (text): skip trace for "${target}" needs ${cost} credit(s), skiptrace balance ${balance} — declined, no charge.`
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
            subject,
            subjectKey,
            credits: cost,
            requestingMessageId: ctx.requestingMessageId,
        });
    }

    /**
     * One /v2/SkipTrace call at a given address (JAK-145), passing the owner's
     * first/last name when known. Thin wrapper so the absentee-mailing trace and its
     * property-address fallback read the same way. Off prod/staging this returns the
     * DAO's no-spend mock, exactly as before.
     */
    private skipTraceAt(
        address: string,
        owner?: { firstName?: string | null; lastName?: string | null }
    ): Promise<RealEstateApiSkipTraceResult | null> {
        return owner
            ? this.realEstateDao.skipTraceByAddress(address, owner)
            : this.realEstateDao.skipTraceByAddress(address);
    }

    /**
     * Resolve the SUBJECT of a skip trace (JAK-145): WHO Jake should trace at this
     * address. Prefers the people the texter NAMED ("skip trace Jane and
     * John"); otherwise the PROPERTY OWNER pulled from PropertySearch ownerInfo —
     * reusing the cached property report's record when present so we never pay for a
     * second lookup, and only falling back to a fresh PropertySearch when there's no
     * snapshot. Returns empty names when neither resolves (the trace then runs on the
     * address alone, exactly as before). Never fabricates a name.
     */
    private async resolveTraceSubject(
        phone: string,
        target: string,
        plan: DispatchPlan
    ): Promise<SkipTraceSubject> {
        // Part B: the texter named specific people to trace.
        const named = (plan.personNames ?? []).map((n) => n.trim()).filter(Boolean);
        if (named.length) {
            const primary = this.splitName(named[0]);
            return { names: named, firstName: primary.firstName, lastName: primary.lastName };
        }

        // Part A: trace the property owner (reuse cached ownerInfo; fetch if absent).
        // For an ABSENTEE owner the trace runs on the owner's MAILING address, not the
        // property address (JAK-145) — see resolveOwnerName / absenteeMailingAddress.
        const owner = await this.resolveOwnerName(phone, target);
        if (owner) {
            const full = [owner.firstName, owner.lastName].filter(Boolean).join(" ").trim();
            return {
                names: full ? [full] : [],
                firstName: owner.firstName,
                lastName: owner.lastName,
                traceAddress: owner.traceAddress,
            };
        }
        return { names: [] };
    }

    /**
     * The property owner's first/last name + the address to trace (JAK-145), pulled
     * from PropertySearch ownerInfo. Prefers the cached report snapshot (the JAK-134
     * lookup cache) so we don't pay for a second PropertySearch; falls back to one
     * fresh PropertySearch when there's no snapshot. Returns null when no owner name
     * is available. Best-effort: a lookup error resolves to null (trace by address).
     *
     * `traceAddress` is the owner's tax MAILING address when the property is ABSENTEE
     * (mailing present AND != property) — the address /v2/SkipTrace should be queried
     * with to reach the owner instead of the property's tenants — else null, so the
     * caller traces the property address as before (see absenteeMailingAddress).
     */
    private async resolveOwnerName(
        phone: string,
        target: string
    ): Promise<{ firstName: string | null; lastName: string | null; traceAddress: string | null } | null> {
        let record: RealEstateApiPropertySearchResult | null = null;
        try {
            const cached = await this.memory.checkCache(phone, target);
            record = (cached?.property_record as RealEstateApiPropertySearchResult | null) ?? null;
            if (!record) record = await this.realEstateDao.searchPropertyByAddress(target);
        } catch (err) {
            console.error("⚠️ Jake owner-name resolve failed:", this.errorSummary(err));
            return null;
        }
        if (!record) return null;

        let firstName = this.text(record.owner1FirstName);
        let lastName = this.text(record.owner1LastName);
        if (!firstName && !lastName) {
            const full = this.text(record.owner1FullName);
            if (full) {
                const parts = this.splitName(full);
                firstName = parts.firstName;
                lastName = parts.lastName;
            }
        }
        if (!firstName && !lastName) return null;
        return { firstName, lastName, traceAddress: this.absenteeMailingAddress(record, target) };
    }

    /**
     * The owner's MAILING address to skip-trace when the property is ABSENTEE
     * (JAK-145), else null. /v2/SkipTrace is ADDRESS-DOMINANT — it returns the
     * current residents of whatever address we pass and ignores the owner name — so
     * for an absentee property the property address returns TENANTS, never the owner;
     * the owner's tax mailing address is where the owner is far more likely reached
     * (live-verified: an individual absentee owner returned as the top match at their
     * own mailing address). When the record's mailing address is present AND differs
     * from the property address, that mailing line is returned so the caller traces
     * it. Returns null for owner-occupants (ownerOccupied === true, or mailing ==
     * property) and when no mailing address is on record, so the caller falls back to
     * the property address. Pure + null-safe: never fabricates an address.
     */
    private absenteeMailingAddress(
        record: RealEstateApiPropertySearchResult,
        target: string
    ): string | null {
        const mailing = this.mailingDisplay(record.mailAddress ?? null);
        if (!mailing) return null;
        // An explicit owner-occupied flag settles it — never divert to a mailing address.
        if (record.ownerOccupied === true) return null;
        const property = this.propertyAddressLine(record) ?? target;
        const norm = (s: string) =>
            String(s ?? "").toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
        if (property && norm(mailing) === norm(property)) return null;
        return mailing;
    }

    /**
     * Build the property's address line from a PropertySearch record (JAK-145) for
     * the absentee mailing-vs-property comparison. The provider ships `address` as a
     * full-line string, a structured object (`address`/`label`/`street` + city/state/
     * zip), so all shapes are read defensively. Null when no address is present.
     */
    private propertyAddressLine(record: RealEstateApiPropertySearchResult): string | null {
        const addr = record.address as
            | string
            | (RealEstateApiAddress & { address?: string | null })
            | null
            | undefined;
        if (typeof addr === "string") return this.text(addr);
        if (addr && typeof addr === "object") {
            const label = this.text(addr.label) ?? this.text(addr.address);
            if (label) return label;
            const line1 =
                this.text(addr.street) ??
                [this.text(addr.house), this.text(addr.street)].filter(Boolean).join(" ");
            const tail = [this.text(addr.city), this.text(addr.state), this.text(addr.zip)]
                .filter(Boolean)
                .join(" ");
            const parts = [line1, tail].filter(Boolean);
            return parts.length ? parts.join(", ") : null;
        }
        return null;
    }

    /**
     * Split a display name ("John Doe", "Jane") into first/last for the
     * /v2/SkipTrace params. The first token is the first name; the remainder (if any)
     * is the last name. Single-token names carry only a first name. Never throws.
     */
    private splitName(name: string): { firstName: string | null; lastName: string | null } {
        const parts = String(name).trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
        if (!parts.length) return { firstName: null, lastName: null };
        if (parts.length === 1) return { firstName: parts[0], lastName: null };
        return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
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
        subject: SkipTraceSubject;
        subjectKey: string;
        credits: number;
        requestingMessageId: string | null;
    }): Promise<JakeInboundResult> {
        const { input, route, customer, accountId, phone, target, subject, subjectKey, credits } = ctx;

        // The paid trace + the LLM writer can take a moment; ack now and deliver the
        // result in a follow-up so the texter isn't left waiting silently (JAK-138).
        await this.sendAck(route, input.contactId);

        // JAK-145: trace the resolved PERSON (owner or texter-named) — pass their
        // first/last name alongside the address so we're asking for the right person,
        // not just the address's top resident.
        const owner =
            subject.firstName || subject.lastName
                ? { firstName: subject.firstName, lastName: subject.lastName }
                : undefined;

        // JAK-145: for an ABSENTEE owner, subject.traceAddress is the owner's MAILING
        // address — /v2/SkipTrace is address-dominant, so the property address returns
        // tenants while the mailing address reaches the owner. Trace the mailing
        // address first; if it yields NO contact, fall back to the property address so
        // an absentee owner with a stale/PO-box mailing still gets a best-effort trace.
        // Owner-occupants have no traceAddress, so they trace the property address once.
        const primaryAddress = subject.traceAddress?.trim() || target;

        let record: RealEstateApiSkipTraceResult | null;
        let data: SkipTraceData;
        try {
            record = await this.skipTraceAt(primaryAddress, owner);
            data = this.assembleSkipTraceData(record, target, subject);
            if (primaryAddress !== target && !hasContactInfo(data)) {
                const fallback = await this.skipTraceAt(target, owner);
                const fallbackData = this.assembleSkipTraceData(fallback, target, subject);
                if (hasContactInfo(fallbackData)) {
                    record = fallback;
                    data = fallbackData;
                }
            }
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
            subjectKey,
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
        subjectKey: string;
        record: RealEstateApiSkipTraceResult;
        reportText: string;
    }): Promise<void> {
        try {
            await this.skipTrace.recordTrace({
                customerId: input.customer.id,
                phone: input.phone,
                messageId: input.requestingMessageId,
                normalizedTarget: input.target,
                subjectKey: input.subjectKey,
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
     *
     * JAK-145: the returned people are grouped into `persons[]`, each with THEIR OWN
     * phones/emails/mailing, so the writer can present names next to their numbers
     * instead of one flat list. The flat `phones`/`emails`/`ownerName` remain as an
     * aggregate for back-compat + the billing gate. `subject` records who we ASKED
     * to trace (the owner, or the texter-named people) for an honest header.
     */
    private assembleSkipTraceData(
        record: RealEstateApiSkipTraceResult | null,
        target: string,
        subject?: SkipTraceSubject | null
    ): SkipTraceData {
        const data: SkipTraceData = {};
        if (target.trim()) data.targetAddress = target.trim();
        const requested = (subject?.names ?? []).map((n) => n.trim()).filter(Boolean);
        if (requested.length) data.requestedName = requested.join(" & ");
        if (!record) return data;

        // JAK-144/145: the LIVE provider returns matches under a top-level `persons[]`
        // array; older/other account shapes nest a single identity under
        // `output.identity` or flatten phones/emails onto the record. Read all of
        // them defensively so every shape resolves — never fabricating a value.
        const persons = this.skipTracePersonContacts(record);
        if (persons.length) data.persons = persons;

        const identity = record.output?.identity ?? null;
        const rawPersons = record.persons ?? [];
        const ownerName = this.skipTraceOwnerName(record, identity, rawPersons);
        if (ownerName) data.ownerName = ownerName;

        // Aggregate flat phones/emails across every matched person (plus the legacy
        // shapes) — back-compat for the billing gate + the LLM's full context.
        const phones = this.dedupe([
            ...persons.flatMap((p) => p.phones ?? []),
            ...(identity?.phones ?? []).map((p) => this.phoneDisplay(p)),
            ...(record.phones ?? []).map((p) => this.phoneDisplay(p)),
        ]);
        if (phones.length) data.phones = phones;

        const emails = this.dedupe([
            ...persons.flatMap((p) => p.emails ?? []),
            ...(identity?.emails ?? []).map((e) => this.emailDisplay(e)),
            ...(record.emails ?? []).map((e) => this.emailDisplay(e)),
        ]);
        if (emails.length) data.emails = emails;

        const mailing =
            persons[0]?.mailingAddress ??
            this.mailingDisplay(identity?.address ?? record.mailAddress ?? null);
        if (mailing) data.mailingAddress = mailing;

        return data;
    }

    /**
     * Group a raw /v2/SkipTrace record into per-person contact blocks (JAK-145):
     * each matched person with THEIR OWN name, phones, emails, and mailing address,
     * de-duplicated. Prefers the live top-level `persons[]`; falls back to a single
     * person built from a legacy `output.identity` / flattened record so older
     * shapes still group cleanly. Only people with at least one field are kept —
     * never fabricates a value.
     */
    private skipTracePersonContacts(record: RealEstateApiSkipTraceResult): SkipTracePersonContact[] {
        const build = (
            name: string | null,
            phones: RealEstateApiSkipTracePhone[],
            emails: Array<string | RealEstateApiSkipTraceEmail>,
            mailing: RealEstateApiMailingAddress | null
        ): SkipTracePersonContact | null => {
            const person: SkipTracePersonContact = {};
            if (name) person.name = name;
            const ph = this.dedupe(phones.map((p) => this.phoneDisplay(p)));
            if (ph.length) person.phones = ph;
            const em = this.dedupe(emails.map((e) => this.emailDisplay(e)));
            if (em.length) person.emails = em;
            const mail = this.mailingDisplay(mailing);
            if (mail) person.mailingAddress = mail;
            return person.name || person.phones || person.emails || person.mailingAddress
                ? person
                : null;
        };

        const persons = record.persons ?? [];
        if (persons.length) {
            return persons
                .map((p) =>
                    build(
                        this.personName(p),
                        p.phones ?? [],
                        p.emails ?? [],
                        p.address ?? null
                    )
                )
                .filter((p): p is SkipTracePersonContact => p !== null);
        }

        // Legacy single-identity / flattened shape → one grouped person.
        const identity = record.output?.identity ?? null;
        const single = build(
            this.skipTraceOwnerName(record, identity, []),
            [...(identity?.phones ?? []), ...(record.phones ?? [])],
            [...(identity?.emails ?? []), ...(record.emails ?? [])],
            identity?.address ?? record.mailAddress ?? null
        );
        return single ? [single] : [];
    }

    /** A single matched person's display name (live `persons[]` shape). */
    private personName(person: RealEstateApiSkipTracePerson): string | null {
        return (
            this.text(person.fullName) ??
            this.text(person.name) ??
            (([person.firstName, person.lastName].filter(Boolean).join(" ").trim()) || null)
        );
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

        // Resolve the address, or ASK when an EXPLICIT ordinal is out of range
        // (JAK-138). A BARE comps request defaults to the MOST RECENT address
        // (JAK-154) — the last property the texter got a report on.
        const resolution = await this.resolveAddressTarget(plan, phone, "most_recent");
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

        // JAK-166: the address this comps run acts on becomes the active property,
        // so a following bare skip/comps stays on it (and an inline "comps 123 Main"
        // makes 123 Main the active property).
        await this.rememberActiveProperty(ctx.requestingMessageId, target);

        // Resolve parameters: admin defaults overlaid with texter overrides, clamped.
        const params = resolveCompParams(await this.compsSettings.defaultParams(), plan.compParams);
        const cost = await this.compsSettings.costOfComps();

        // Free re-serve: a repeat of the same target AND parameter-set in the window.
        const cached = await this.comps.checkCache(phone, target, params);
        if (cached) {
            return this.reserveCompsFromCache({ input, route, customer, phone, target, params, cached, cost });
        }

        // JAK-144: run immediately — NO "reply OK" confirmation. Credit gate FIRST
        // on the COMPS bucket only (JAK-161): insufficient balance → do NOT run,
        // reply with the admin-editable comps out-of-credits message, no charge.
        if (!(await this.credits.hasCreditsForComps(accountId, cost))) {
            const balance = await this.credits.getBalance(accountId, "comps");
            const reply = await this.outOfCreditsReply("comps");
            await this.sendAndRemember(route, input.contactId, customer, phone, reply);
            await this.writeStatusNote(
                route,
                input.contactId,
                `Jake (text): comps for "${target}" needs ${cost} credit(s), comps balance ${balance} — declined, no charge.`
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

        // JAK-164: the SELECTION ENGINE assembles a REAL up-to-10-mile candidate pool
        // via /v2/PropertySearch and picks the strongest true comps (LLM with a
        // deterministic fallback; numbers always code-derived), falling back to the
        // legacy cluster only when the radius pool yields nothing usable. It always
        // returns a result object, so Jake always replies.
        let result: Awaited<ReturnType<CompsSelectionEngine["buildComps"]>>;
        try {
            result = await this.compsEngine.buildComps({ target, params });
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

        const data = result.data;
        if (!hasComps(data)) {
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
            record: result.record,
            reportText: reply,
        });

        await this.writeStatusNote(
            route,
            input.contactId,
            `Jake (text): pulled comps for "${target}" [${formatCompParams(params)}] via ${result.source}/${result.selectionMode} (${data.comps.length} comp(s)) — charged ${charged} credit(s).`
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
        record: unknown;
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
     *   - `resolved` when the router pinned a target, an in-range ordinal resolves,
     *     or (bare skip-trace / comps) we default to the MOST RECENT address;
     *   - `ask` when the reference is OUT OF RANGE (an ordinal past the list), or —
     *     for `bareFallback: "ask"` (property reports) — a bare command is AMBIGUOUS
     *     (2+ addresses on file, no clear pick). Jake lists them and asks.
     *   - `none` when there's nothing to act on (no addresses at all), so the caller
     *     falls through to guidance.
     *
     * `bareFallback` decides the NO-REFERENCE (bare) case (JAK-154): a bare
     * "skip trace" / "pull comps" carries no address AND no ordinal, so it defaults
     * to `"most_recent"` — the LAST address the texter engaged with (their most
     * recent property report / lookup) — NOT the first-in-list and NOT a prior
     * disambiguation ask. Property reports keep `"ask"` so a bare report across 2+
     * addresses still disambiguates. EXPLICIT references (a fresh address, "the 2nd
     * address", "the last one", a named person) are unaffected — they resolve or ask
     * exactly as before.
     */
    private async resolveAddressTarget(
        plan: DispatchPlan,
        phone: string,
        bareFallback: "most_recent" | "ask" = "ask"
    ): Promise<
        | { kind: "resolved"; target: string }
        | { kind: "ask"; addresses: string[]; outOfRange: boolean; requested: number | null }
        | { kind: "none" }
    > {
        if (plan.targetEntity) return { kind: "resolved", target: plan.targetEntity };

        // JAK-159: an EXPLICIT "last" reference ("comp the last one", "skip the last
        // property") resolves to the genuinely MOST-RECENT address — the same target a
        // bare command uses (JAK-154, lastResolvedAddress, created_at DESC) — NOT the
        // end of the first-appearance ordinal list, which the router's addressOrdinal
        // would point at and which can disagree after the texter re-sends an older
        // address. The orchestrator leaves targetEntity null and sets this flag so the
        // resolution happens here, where the DB is reachable.
        if (plan.addressRecency === "last") {
            const mostRecent = await this.memory.lastResolvedAddress(phone);
            if (mostRecent) return { kind: "resolved", target: mostRecent };
            return { kind: "none" };
        }

        const ordinal = plan.addressOrdinal ?? null;

        // An EXPLICIT ordinal reference ("the 2nd address", "the last one"). In-range
        // ordinals are normally resolved to targetEntity upstream (JAK-135); resolve
        // here too defensively. Out of range → list what's on file and ASK (JAK-138).
        if (ordinal != null) {
            const addresses = (await this.memory.resolvedAddressList(phone)) ?? [];
            if (ordinal >= 1 && ordinal <= addresses.length) {
                return { kind: "resolved", target: addresses[ordinal - 1] };
            }
            if (addresses.length >= 1) {
                return { kind: "ask", addresses, outOfRange: true, requested: ordinal };
            }
            return { kind: "none" };
        }

        // JAK-154: a BARE skip-trace / comps (no explicit address, no ordinal) targets
        // the MOST RECENT address the texter engaged with — the last property they got
        // a report on — so a bare "skip trace" hits the newest property, never an older
        // one it already handled.
        if (bareFallback === "most_recent") {
            const mostRecent = await this.memory.lastResolvedAddress(phone);
            if (mostRecent) return { kind: "resolved", target: mostRecent };
            return { kind: "none" };
        }

        // Property reports (JAK-138): a bare command with 2+ addresses on file is
        // AMBIGUOUS → ask which one; 0–1 addresses → let the caller fall back.
        const addresses = (await this.memory.resolvedAddressList(phone)) ?? [];
        if (addresses.length >= 2) {
            return { kind: "ask", addresses, outOfRange: false, requested: null };
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
     * Reply to an inbound from a held customer (JAK-148) WITHOUT doing any work.
     * on_hold and deactivated both land here: we record the inbound for history
     * (memory only), send the fixed hold notice, and drop a status note — no
     * orchestrator, no specialist, no credit charge. Returns a benign result with
     * the status as its intent for telemetry.
     */
    private async replyAccountHeld(
        input: JakeInboundMessage,
        route: TextRoute,
        customer: TextJakeCustomer,
        phone: string
    ): Promise<JakeInboundResult> {
        // Best-effort history only — never a specialist, never a charge.
        await this.rememberInbound(customer, phone, input.message, null, route);
        await this.sendAndRemember(route, input.contactId, customer, phone, ACCOUNT_ON_HOLD_REPLY);
        const label = customer.status === "deactivated" ? "DEACTIVATED" : "ON HOLD";
        await this.writeStatusNote(
            route,
            input.contactId,
            `Jake (text): account ${label} — sent hold notice, no processing, no charge.`
        );
        return {
            ok: true,
            address: null,
            reply: ACCOUNT_ON_HOLD_REPLY,
            mode: route.mode,
            charged: 0,
            intent: customer.status,
        };
    }

    // ── Onboarding (JAK-first-text-welcome) ──────────────────────────────────

    /**
     * Send the one-time INTRO on a new customer's first-ever NON-ADDRESS text
     * (JAK-silent-credits-intro): a clean greeting that invites an address. The
     * seeded starting credits are granted SILENTLY (CreditService already did it at
     * customer creation) and are NEVER announced — the only place credits are ever
     * surfaced is the out-of-credits message. Deliberately does NOT ask for
     * name/email — that ask is delayed to after the 3rd report. Best-effort: an intro
     * hiccup must never block anything. Returns the reply that was sent (so a
     * first-contact 'credit' can surface it as its result, JAK-credit-keyword), or
     * null if the intro couldn't be built.
     */
    private async sendIntro(
        route: TextRoute,
        input: JakeInboundMessage,
        customer: TextJakeCustomer,
        phone: string
    ): Promise<string | null> {
        try {
            const reply = this.withFooter(buildIntroMessage());
            await this.sendAndRemember(route, input.contactId, customer, phone, reply);
            await this.writeStatusNote(
                route,
                input.contactId,
                "Jake (text): new customer — sent first-contact intro (starting credits granted silently, none announced)."
            );
            return reply;
        } catch (err) {
            console.error("⚠️ Jake intro send failed:", this.errorSummary(err));
            return null;
        }
    }

    // ── Credit-status keyword (JAK-credit-keyword) ────────────────────────────

    /**
     * True when the inbound is the bare status command 'credit'/'credits'
     * (case-insensitive, trimmed). Non-letters are stripped before the match so
     * "Credits!", " credit " etc. still count, while a phrase ("credit balance") or
     * an address ("123 Credit St") collapses to something outside the keyword set —
     * so the keyword never over-matches a real report request.
     */
    private isCreditKeyword(message: string): boolean {
        const compact = String(message).trim().toLowerCase().replace(/[^a-z]/g, "");
        return JakeAssistantService.CREDIT_KEYWORDS.has(compact);
    }

    /**
     * Reply to a 'credit'/'credits' status command (JAK-credit-keyword). READ-ONLY:
     * reports the three current per-bucket balances (report / skip-trace / comps) and
     * the next reset date, and charges/deducts NOTHING.
     *
     * New-customer edge case: when the FIRST-EVER text is 'credit', we keep first
     * contact clean (JAK-silent-credits-intro) — credits are seeded silently and
     * never announced, so we send the plain intro (no balances) rather than surfacing
     * numbers on the very first message. Balances are only ever reported to an
     * ESTABLISHED customer who asks, or via the out-of-credits message.
     */
    private async replyCreditBalance(ctx: {
        input: JakeInboundMessage;
        route: TextRoute;
        customer: TextJakeCustomer;
        phone: string;
        firstContact: boolean;
    }): Promise<JakeInboundResult> {
        const { input, route, customer, phone, firstContact } = ctx;

        if (firstContact) {
            const intro = await this.sendIntro(route, input, customer, phone);
            return {
                ok: true,
                address: null,
                reply: intro ?? "",
                mode: route.mode,
                charged: 0,
                intent: "credit_balance",
            };
        }

        const balances = await this.credits.getBalances(customer.creditAccountId);
        const reply = this.withFooter(
            buildCreditBalanceMessage({
                report: balances.report,
                skiptrace: balances.skiptrace,
                comps: balances.comps,
                nextResetAt: customer.nextResetAt,
            })
        );
        await this.sendAndRemember(route, input.contactId, customer, phone, reply);
        await this.writeStatusNote(
            route,
            input.contactId,
            `Jake (text): reported credit balances (report ${balances.report}, skiptrace ${balances.skiptrace}, comps ${balances.comps}) — read-only, no charge.`
        );
        return { ok: true, address: null, reply, mode: route.mode, charged: 0, intent: "credit_balance" };
    }

    /**
     * Record one delivered report and, when the customer just hit the
     * {@link ONBOARDING_AFTER_REPORTS}rd, send the DELAYED onboarding email ask
     * ONCE (JAK-first-text-welcome). The once-guard is the atomic
     * `markOnboardingAsked` (conditional on the stamp being unset), so even a fuzzy
     * count can't double-ask. Skipped entirely when we already have the customer's
     * name + email. Best-effort: a hiccup never affects the report the texter got.
     */
    private async recordReportDelivered(
        route: TextRoute,
        input: JakeInboundMessage,
        customer: TextJakeCustomer,
        phone: string
    ): Promise<void> {
        try {
            const count = (await this.customers.incrementReportCount(customer.id)) ?? 0;
            if (count < JakeAssistantService.ONBOARDING_AFTER_REPORTS) return;
            // Already onboarded (we have their info) or already asked → never ask.
            if (this.hasContactInfo(customer)) return;
            if (customer.onboardingAskedAt) return;
            const claimed = await this.customers.markOnboardingAsked(customer.id);
            if (!claimed) return;

            const ask = this.withFooter(await this.onboardingPrompt.getEffectivePrompt());
            await this.sendAndRemember(route, input.contactId, customer, phone, ask);
            await this.writeStatusNote(
                route,
                input.contactId,
                `Jake (text): sent the onboarding email ask after report #${count} — no charge.`
            );
        } catch (err) {
            console.error("⚠️ Jake onboarding ask failed:", this.errorSummary(err));
        }
    }

    /**
     * If this non-first-contact message is a profile answer (a name/email reply to
     * the onboarding ask), capture it into the customer's profile and acknowledge —
     * returning the handled result. Otherwise return null so normal dispatch runs.
     *
     * Gated so it NEVER hijacks real usage: only after we've actually asked
     * (onboardingAskedAt set), only while the profile is still incomplete, only when
     * the message carries no address to act on, and only when it parses to real
     * profile info. Providing info is optional — anyone who ignores the ask and
     * keeps texting addresses is unaffected.
     */
    private async tryCaptureProfile(ctx: {
        input: JakeInboundMessage;
        route: TextRoute;
        customer: TextJakeCustomer;
        phone: string;
        address: string | null;
    }): Promise<JakeInboundResult | null> {
        const { input, route, customer, phone, address } = ctx;
        if (address) return null;
        if (!customer.onboardingAskedAt) return null;
        if (this.hasContactInfo(customer)) return null;

        const captured: CapturedProfile | null = parseProfileReply(input.message);
        if (!captured) return null;

        await this.customers.captureProfile(customer.id, captured);
        const reply = this.withFooter(buildProfileAck(captured));
        await this.sendAndRemember(route, input.contactId, customer, phone, reply);
        await this.writeStatusNote(
            route,
            input.contactId,
            `Jake (text): captured profile info from a follow-up reply (${[
                captured.firstName ? "first" : null,
                captured.lastName ? "last" : null,
                captured.email ? "email" : null,
            ]
                .filter(Boolean)
                .join("+")}) — no charge.`
        );
        return { ok: true, address: null, reply, mode: route.mode, charged: 0 };
    }

    /** True once we have the customer's name AND email — the point of the ask. */
    private hasContactInfo(customer: TextJakeCustomer): boolean {
        return Boolean(customer.firstName?.trim() && customer.email?.trim());
    }

    /** Append the canonical GoTextJake.com footer to a message body. */
    private withFooter(body: string): string {
        return [body, PropertyReportWriter.FOOTER].join("\n\n");
    }

    /**
     * The help / capability menu (JAK-138) — sent for a greeting, an unrecognized
     * message, or an explicit "help". It plainly lists what Jake can do. Per
     * JAK-silent-credits-intro it NO LONGER shows per-action credit costs: credits
     * are never surfaced to a customer anywhere except the out-of-credits message.
     * Emoji-free, GoTextJake.com footer last. No lookup, no charge.
     */
    private async sendGuidance(
        input: JakeInboundMessage,
        route: TextRoute,
        customer: TextJakeCustomer,
        phone: string
    ): Promise<JakeInboundResult> {
        const reply = this.buildHelpReply();
        await this.sendAndRemember(route, input.contactId, customer, phone, reply);
        await this.writeStatusNote(
            route,
            input.contactId,
            "Jake (text): sent the help / capability menu — no lookup, no charge."
        );
        return { ok: true, address: null, reply, mode: route.mode, charged: 0 };
    }

    /**
     * Compose the capability menu. Lists what Jake can do WITHOUT any credit costs
     * (JAK-silent-credits-intro) — the only place credits are ever surfaced to a
     * customer is the out-of-credits message.
     */
    private buildHelpReply(): string {
        return [
            "Hi! I'm Jake. Here's what I can do — just text a full property address to start:",
            [
                "- Property report — owner, value, equity, and distress signals.",
                "- Find the owner / skip trace — their phone and contact info.",
                "- Comparable sales / comps — recent nearby sales for a property.",
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

    /**
     * JAK-166: make the address a command actually acts on the conversation's
     * single active property. The insert-time regex (parseCommandAddress) only
     * captures a bare, house-number-first address; when the texter wraps it in
     * preamble ("Hey Jake, look up 123 Main St") the parse fails and the inbound
     * row stores NO address, even though the lookup succeeds on the LLM-resolved
     * target. Backfilling that resolved target onto the requesting message keeps
     * lastResolvedAddress (created_at DESC) pointed at the property the texter is
     * really on, so a later bare comps/skip can't drift to a stale older address.
     * Best-effort: a memory hiccup must never break the customer's reply.
     */
    private async rememberActiveProperty(
        requestingMessageId: string | null,
        address: string
    ): Promise<void> {
        if (!requestingMessageId) return;
        try {
            await this.memory.markResolvedAddress(requestingMessageId, address);
        } catch (err) {
            console.error("⚠️ Jake active-property update failed:", this.errorSummary(err));
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
     * Per JAK-silent-credits-intro the notice does NOT state a credit price — credits
     * are never surfaced to a customer anywhere except the out-of-credits message; it
     * still tells the texter this copy is free and that OK fetches a fresh one.
     */
    private withReserveNotice(reportText: string): string {
        const notice =
            "This address is already on record, so this copy is free. " +
            "Reply OK for a fresh copy.";
        const footer = PropertyReportWriter.FOOTER;
        // A report cached BEFORE JAK-kill-report-menu may still carry the old
        // "Next Commands" menu; strip it so even a free re-serve comes back clean.
        const trimmed = PropertyReportWriter.stripCommandMenu(reportText).trimEnd();
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

        // Reply FROM the exact number the customer texted (the inbound destination),
        // so Jake mirrors the number the text arrived on instead of letting GHL pick
        // the gateway sub-account's default number. Before this, no fromNumber was
        // sent → GHL fell back to that ONE default, so after a toll-free swap the
        // inbound landed on the new number but the reply still went out from the OLD
        // default (JAK-167). The candidate is GHL-supplied (the webhook is
        // MASTER_API_KEY-guarded) and GHL only sends from a number provisioned in the
        // sub-account, so a mirrored destination is safe; absent → undefined, which
        // keeps the prior default-number behavior.
        // Precedence (JAK-force-fromnumber-833):
        //   1. mirror the inbound destination if the webhook supplied one (JAK-167);
        //   2. else the CONFIGURED gateway default (JAKE_GATEWAY_FROM_NUMBER) — GHL's
        //      inbound webhook does NOT include the destination, so candidateNumbers is
        //      usually empty; without this Jake fell back to GHL's sub-account default
        //      (the OLD number) even after the toll-free swap;
        //   3. else undefined → GHL's sub-account default (unchanged when the var is
        //      unset, so backward compatible).
        const mirroredFrom = (input.candidateNumbers ?? [])
            .map((n) => (n ? String(n).trim() : ""))
            .find((n) => n.length > 0);
        const gatewayReplyFrom = mirroredFrom || this.gateway.defaultFromNumber;
        return {
            mode: "gateway",
            send: (contactId, message) =>
                this.gateway.sendSms({ contactId, message, fromNumber: gatewayReplyFrom || undefined }),
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
