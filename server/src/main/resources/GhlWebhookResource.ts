import { Router, Request, Response } from "express";
import { injectable, inject } from "tsyringe";
import { LeadEnrichmentQueueService } from "../services/LeadEnrichmentQueueService";

@injectable()
export class GhlWebhookResource {
  public readonly router: Router;

  constructor(
      @inject(LeadEnrichmentQueueService) private readonly queue: LeadEnrichmentQueueService
  ) {
    this.router = Router();
    this.configureRoutes();
  }

  private configureRoutes(): void {
    this.router.post(
        "/webhook",
        this.handleWebhook.bind(this)
    );
  }

  private async handleWebhook(req: Request, res: Response): Promise<Response> {
    try {
      const {
        contact_id,
        address1,
        city,
        state,
        postal_code,
      } = req.body;

      // Validate required fields
      if (!contact_id || !address1 || !city || !state || !postal_code) {
        return res.status(400).json({ error: "Missing required address fields" });
      }

      // ✅ Build a consistent, comma-formatted full address
      const full_address = `${address1.trim()}, ${city.trim()}, ${state.trim()} ${postal_code.trim()}`;

      console.log(`🏗️ Constructed full_address: "${full_address}"`);

      // Enqueue enrichment job using the normalized address
      const job = await this.queue.enqueue({
        contact_id,
        full_address,
      });

      return res.status(202).json({ ok: true, jobId: job.id, full_address });
    } catch (err) {
      console.error("❌ Error in GHL webhook handler:", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }
}