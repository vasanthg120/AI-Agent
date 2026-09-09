import { IsNotEmpty, IsString } from 'class-validator';

// The user confirms a specific match from FinanceDocumentsService.searchCustomerQuotes's
// preview before this is ever called — quoteId, not the raw typed quote
// number, is what actually gets persisted (see finance-documents.service.ts's
// linkCustomerQuote, which re-resolves and re-validates this id against the
// caller's own organization regardless of what the client sends).
export class LinkCustomerQuoteDto {
  @IsString()
  @IsNotEmpty()
  quoteId: string;
}
