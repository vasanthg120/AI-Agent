import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type InvoiceTemplateDocument = InvoiceTemplate & Document<Types.ObjectId>;

// A named bundle of layout CHOICES, not free-form HTML/markup — PDF
// generation here is programmatic (pdfkit, see billing-invoice-pdf.service.ts),
// not an HTML-to-PDF renderer, so there's no template-injection surface to
// worry about; "customizing the template" means picking from a fixed set of
// toggles/colors, matching InvoiceTemplateService's actual rendering
// capabilities exactly (never claim a knob the renderer doesn't honor).
@Schema({ timestamps: true, collection: 'billing_invoice_templates' })
export class InvoiceTemplate {
  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ required: true })
  name: string;

  // Exactly one template has this true — enforced in
  // BillingAdminInvoiceTemplatesService the same unset-every-other-row-first
  // way Currency.isDefault/PaymentMethod.isDefault already are.
  @Prop({ default: false })
  isDefault: boolean;

  @Prop({ default: true })
  showLogo: boolean;

  @Prop({ default: true })
  showTaxBreakdown: boolean;

  @Prop()
  footerText?: string;

  @Prop()
  accentColorHex?: string;

  @Prop({ default: true, index: true })
  active: boolean;
}

export const InvoiceTemplateSchema = SchemaFactory.createForClass(InvoiceTemplate);
