import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { BillingAdminTemplatesService } from './billing-admin-templates.service';
import { CreateInvoiceTemplateDto } from './dto/create-invoice-template.dto';
import { UpdateInvoiceTemplateDto } from './dto/update-invoice-template.dto';

@UseGuards(AdminJwtAuthGuard)
@Controller('billing/admin/invoice-templates')
export class BillingAdminTemplatesController {
  constructor(private templatesService: BillingAdminTemplatesService) {}

  @Get()
  list() {
    return this.templatesService.listTemplates();
  }

  @Post()
  create(@Body() dto: CreateInvoiceTemplateDto) {
    return this.templatesService.createTemplate(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateInvoiceTemplateDto) {
    return this.templatesService.updateTemplate(id, dto);
  }

  @Post(':id/activate')
  activate(@Param('id') id: string) {
    return this.templatesService.setActive(id, true);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id') id: string) {
    return this.templatesService.setActive(id, false);
  }
}
