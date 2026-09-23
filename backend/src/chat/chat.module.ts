import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RedisCacheService } from '../common/redis/redis-cache.service';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AgentRole, AgentRoleSchema } from '../agent-roles/schemas/agent-role.schema';
import { Conversation, ConversationSchema } from './schemas/conversation.schema';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Conversation.name, schema: ConversationSchema },
      // Independent local registration (not imported from AgentRolesModule) —
      // Mongoose's core connection module is global, so any module can bind
      // its own model to the same 'agent_roles' collection. Used to merge
      // activated dynamic roles into listAgents() for the @mention widget.
      { name: AgentRole.name, schema: AgentRoleSchema },
    ]),
    // Agentic tool-calling turns (CRM/Outlook lookups across several rounds)
    // can legitimately take well over 30s — see chat.service.ts's callAgent.
    // A real investigative question (e.g. "why was this deal lost?") can
    // trigger several planner rounds each with multiple real external CRM
    // API calls (up to MAX_TOOL_ROUNDS=5 rounds in app/agent/graph.py) —
    // confirmed live to sometimes exceed 120s and hit this timeout even
    // after python-agent successfully completes the request. 300s gives
    // genuine headroom without being unbounded.
    HttpModule.register({ timeout: 300_000 }),
    AuthModule,
    // Needed for ChatGateway's own session-revocation check on socket
    // connect (mirrors JwtStrategy's HTTP-side check) — no cycle: UsersModule
    // imports nothing from this module or AuthModule.
    UsersModule,
  ],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway, RedisCacheService],
  // StoreSettingsModule (via DashboardService.recordDailyReport) calls
  // ChatService.createSystemConversationRecord() to give every roster user a
  // copy of the scheduled morning to-do / EOD report in their own Chat
  // History, without a live agent call per user. ChatGateway is exported so
  // NotificationsModule can push live socket events through the same
  // per-user-room connections chat already uses (see ChatGateway.emitToUser).
  exports: [ChatService, ChatGateway],
})
export class ChatModule {}
