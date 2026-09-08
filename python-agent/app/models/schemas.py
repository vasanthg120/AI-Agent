from pydantic import BaseModel


class ChatRequest(BaseModel):
    user_id: str
    conversation_id: str
    message: str
    agent_id: str | None = None


class ChatResponse(BaseModel):
    reply: str
    tools_used: list[str] = []


class IngestResponse(BaseModel):
    document_id: str
    chunks: int
    status: str


class RoleKpi(BaseModel):
    name: str
    description: str


class RoleGenerateResponse(BaseModel):
    documentId: str
    chunks: int
    sourceDocumentName: str
    name: str
    department: str
    description: str
    goals: list[str]
    responsibilities: list[str]
    dailyTasks: list[str]
    weeklyTasks: list[str]
    kpis: list[RoleKpi]
    systemPrompt: str


class RoleGenerateFromDescriptionRequest(BaseModel):
    description: str
    user_id: str


# Agent Builder Phase 1's Describe method — same fields as
# RoleGenerateResponse minus the document-specific ones (documentId/chunks/
# sourceDocumentName), since there's no uploaded file to embed.
class RoleGenerateFromDescriptionResponse(BaseModel):
    name: str
    department: str
    description: str
    goals: list[str]
    responsibilities: list[str]
    dailyTasks: list[str]
    weeklyTasks: list[str]
    kpis: list[RoleKpi]
    systemPrompt: str


class SourceRef(BaseModel):
    documentId: str


class FinanceTaxDetails(BaseModel):
    gstAmount: float | None = None
    vatAmount: float | None = None
    taxRatePct: float | None = None
    taxType: str | None = None


class FinanceBankDetails(BaseModel):
    bankName: str | None = None
    accountNumber: str | None = None
    ifscOrSwift: str | None = None
    accountHolderName: str | None = None


class BusinessProfileSyncResponse(BaseModel):
    documentId: str
    chunkCount: int


class EmailAnalysisResponse(BaseModel):
    intent: str
    priority: str
    urgency: str
    sentiment: str
    recommendedAction: str
    shouldDraft: bool
    draftReply: str | None = None
    draftReasoning: str | None = None
    requestedItems: str | None = None
    draftWrittenFromOurPerspective: bool | None = None


class BusinessDocumentExtractResponse(BaseModel):
    vectorDocumentId: str
    vectorChunkCount: int
    title: str
    assetType: str
    summary: str
    keyTopics: list[str] = []
    extractedEntities: dict = {}
    missingFields: list[str] = []
    inconsistencyNotes: list[str] = []


class BusinessKnowledgeChatSource(BaseModel):
    index: int
    sourceType: str
    documentId: str | None = None
    filename: str | None = None
    snippet: str


class BusinessKnowledgeChatResponse(BaseModel):
    answer: str
    sources: list[BusinessKnowledgeChatSource] = []


class FinanceExtractResponse(BaseModel):
    vectorDocumentId: str
    vectorChunkCount: int
    vendorName: str | None = None
    vendorId: str | None = None
    invoiceNumber: str | None = None
    poNumber: str | None = None
    invoiceDate: str | None = None
    dueDate: str | None = None
    paymentDate: str | None = None
    paymentAmount: float | None = None
    currency: str | None = None
    taxAmount: float | None = None
    taxDetails: FinanceTaxDetails | None = None
    deliveryCharges: float | None = None
    isSubscriptionPayment: bool = False
    subscriptionProvider: str | None = None
    subscriptionCharges: float | None = None
    paymentMethod: str | None = None
    bankDetails: FinanceBankDetails | None = None
    department: str | None = None
    costCenter: str | None = None
    paymentStatus: str
    expenseCategory: str
    otherFinancialInfo: dict = {}
    summary: str
    missingFields: list[str] = []
    inconsistencyNotes: list[str] = []
