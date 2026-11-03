import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CloudAccessService } from './cloud-access.service';
import { CloudConnectionsService } from './cloud-connections.service';
import { CloudFilesController } from './cloud-files.controller';
import { CloudFilesService } from './cloud-files.service';
import { GoogleDriveProvider } from './providers/google-drive.provider';
import { OneDriveProvider } from './providers/onedrive.provider';
import { CloudConnection, CloudConnectionSchema } from './schemas/cloud-connection.schema';
import { CloudFolderGrant, CloudFolderGrantSchema } from './schemas/cloud-folder-grant.schema';

// Google Drive and Microsoft OneDrive (2026-10-15).
//
// Setup, per provider:
//  - OneDrive: the Outlook app registration (MS_GRAPH_CLIENT_ID/SECRET) and its
//    registered return address MS_GRAPH_REDIRECT_URI (/outlook/callback hands a
//    cloud-files state over to CloudConnectionsService). Delegated permissions
//    asked: offline_access, User.Read, Files.ReadWrite.All. A tenant that blocks
//    user consent needs Files.ReadWrite.All added to the registration's API
//    permissions, then the existing "approve for the organization" button.
//  - Google Drive: an OAuth client of its own (GOOGLE_DRIVE_CLIENT_ID/SECRET,
//    return address GOOGLE_DRIVE_REDIRECT_URI → /cloud-files/google/callback) in
//    a Google Cloud project with the Drive API enabled. Full Drive access is a
//    restricted scope: in Testing only listed test users can connect and Google
//    expires their access after 7 days; production needs Google's verification
//    and its yearly security assessment (an Internal Workspace app does not).
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CloudConnection.name, schema: CloudConnectionSchema },
      { name: CloudFolderGrant.name, schema: CloudFolderGrantSchema },
    ]),
    HttpModule.register({ timeout: 30_000 }),
    AuthModule,
    AuditModule,
  ],
  controllers: [CloudFilesController],
  providers: [GoogleDriveProvider, OneDriveProvider, CloudConnectionsService, CloudAccessService, CloudFilesService],
  exports: [CloudConnectionsService, CloudAccessService, CloudFilesService],
})
export class CloudFilesModule {}
