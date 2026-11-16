import { IsIn, IsString, MinLength } from 'class-validator';

// A Square "Personal Access Token" pasted directly from the organization's
// own Square Developer Console (Sandbox access token or production
// personal access token — see square.service.ts's own class comment for
// why this is the right token type here, not an OAuth-issued one).
// applicationId is required alongside it per the user's own simplified-
// credentials spec — stored for identification only, never sent as a
// secret or required by Square to authenticate the request (the access
// token alone does that).
export class ConnectSquareDto {
  @IsString()
  @MinLength(5)
  applicationId: string;

  @IsString()
  @MinLength(10)
  accessToken: string;

  @IsIn(['sandbox', 'production'])
  environment: 'sandbox' | 'production';
}
