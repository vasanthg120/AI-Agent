import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { Response } from 'express';
import { CloudError, CloudErrorKind } from './cloud-http';

// A provider's refusal reaches the page as a plain message and a `kind` the page
// can act on (show Reconnect, offer Retry…). Never 401: that status means "your
// HaiVE session ended" to the frontend and would sign the person out.
const STATUS: Record<CloudErrorKind, number> = {
  auth: 409,
  permission: 403,
  not_found: 404,
  conflict: 409,
  rate_limit: 429,
  too_large: 413,
  unavailable: 502,
  bad_request: 400,
  not_configured: 503,
};

@Catch(CloudError)
export class CloudErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('CloudFiles');

  catch(error: CloudError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error.detail) this.logger.warn(`${error.kind}: ${error.detail}`);
    // Headers already sent (a download that failed halfway): all that can be done is to stop.
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.status(STATUS[error.kind]).json({ statusCode: STATUS[error.kind], message: error.message, kind: error.kind });
  }
}
