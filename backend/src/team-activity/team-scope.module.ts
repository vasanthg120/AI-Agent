import { Module } from '@nestjs/common';
import { TeamScopeService } from './team-scope.service';

// Who may look at whose work — on its own so Call Copilot can use it without
// depending on the team views (or the email module they read).
@Module({
  providers: [TeamScopeService],
  exports: [TeamScopeService],
})
export class TeamScopeModule {}
