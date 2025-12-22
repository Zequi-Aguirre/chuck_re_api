import { Router, Request, Response } from 'express';
import { injectable } from 'tsyringe';
import { LeadEnrichmentQueueService } from '../services/LeadEnrichmentQueueService';
import { GhlLeadImportedWebhookBody } from '../types/LeadEnrichment';

@injectable()
export class GhlWebhookResource {
  public readonly router: Router;

  constructor(private readonly queue: LeadEnrichmentQueueService) {
    this.router = Router();

    // Webhook endpoint for GHL lead imports
    this.router.post(
      '/webhooks/lead-imported',
      async (req: Request, res: Response) => {
        try {
          const body = req.body as GhlLeadImportedWebhookBody;

          if (!body?.contactId || !body?.locationId || !body?.address) {
            return res
              .status(400)
              .json({ ok: false, error: 'Missing required lead fields' });
          }

          const addressString = `${body.address.address1}, ${body.address.city} ${body.address.state} ${body.address.postalCode}`;
          const jobId = await this.queue.enqueue({
            locationId: body.locationId,
            contactId: body.contactId,
            addressString,
          });

          return res.status(202).json({ ok: true, jobId });
        } catch (error: any) {
          console.error('Error handling GHL webhook:', error);
          return res
            .status(500)
            .json({ ok: false, error: error.message ?? 'Internal error' });
        }
      }
    );
  }
}