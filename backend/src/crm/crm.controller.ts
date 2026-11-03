import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CrmService } from './crm.service';
import { Permission } from '../common/permissions/permission.decorator';

/**
 * Native CRM bridge — the exact route paths and request/response shapes
 * python-agent's crm_*_tool.py files already call against an external CRM
 * (see prospectconnect.py's native fallback). Every request body here is
 * shaped by that pre-existing external contract, not by our own conventions
 * (mixed snake_case/camelCase, nested `data` objects) — bodies are read as
 * plain objects (untyped `Object` params skip the global ValidationPipe's
 * whitelist/forbidNonWhitelisted checks) rather than forced through DTOs that
 * would have to imperfectly re-describe someone else's API shape.
 */
@UseGuards(JwtAuthGuard)
@Permission('customers', 'view')
@Controller('crm')
export class CrmController {
  constructor(private crmService: CrmService) {}

  @Post('contact/upsert')
  @Permission('customers', 'create')
  upsertContact(@CurrentUser() user: JwtPayload, @Body() body: { data: Record<string, unknown> }) {
    return this.crmService.upsertContact(user.organizationId, body.data ?? {});
  }

  @Post('contact/search/contact-by-ids')
  searchContactsByIds(@CurrentUser() user: JwtPayload, @Body() body: { ids: string[] }) {
    return this.crmService.searchContactsByIds(user.organizationId, body.ids ?? []);
  }

  @Post('contact/search/contact')
  listContacts(
    @CurrentUser() user: JwtPayload,
    @Body() body: { search_after?: number; limit?: number; search_text?: string },
  ) {
    return this.crmService.listContacts(user.organizationId, {
      searchAfter: body.search_after,
      limit: body.limit,
      searchText: body.search_text,
    });
  }

  @Post('deal/getDealsByBusinessId')
  listDeals(
    @CurrentUser() user: JwtPayload,
    @Body() body: { page?: number; offset?: number; page_limit?: number; search?: string; pipelineId?: string },
  ) {
    return this.crmService.listDeals(user.organizationId, {
      page: body.page,
      offset: body.offset,
      pageLimit: body.page_limit,
      search: body.search,
      pipelineId: body.pipelineId,
    });
  }

  @Post('note/getNotes')
  getNotes(
    @CurrentUser() user: JwtPayload,
    @Body() body: { contact_id: string; deal_ids?: string[]; account_ids?: string[] },
  ) {
    return this.crmService.getNotes(user.organizationId, body.contact_id, body.deal_ids?.[0], body.account_ids?.[0]);
  }

  @Post('tag/fetchTagList')
  listTags(
    @CurrentUser() user: JwtPayload,
    @Body() body: { name?: string; module_name?: string; limit?: number; offset?: number },
  ) {
    return this.crmService.listTags(user.organizationId, {
      name: body.name,
      moduleName: body.module_name,
      limit: body.limit,
      offset: body.offset,
    });
  }

  @Post('account/fetch-account-list')
  listAccounts(@CurrentUser() user: JwtPayload, @Body() body: { name?: string; limit?: number; offset?: number }) {
    return this.crmService.listAccounts(user.organizationId, body);
  }

  @Post('product/get-product-by-pagination')
  listProducts(@CurrentUser() user: JwtPayload) {
    return this.crmService.listProducts(user.organizationId);
  }

  @Post('quotes/getQuotes')
  listQuotes(
    @CurrentUser() user: JwtPayload,
    @Body() body: { search?: string; deal_id?: string; limit?: number; startAfter?: number },
  ) {
    return this.crmService.listQuotes(user.organizationId, {
      search: body.search,
      dealId: body.deal_id,
      limit: body.limit,
      startAfter: body.startAfter,
    });
  }
}
