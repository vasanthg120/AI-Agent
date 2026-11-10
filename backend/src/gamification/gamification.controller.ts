import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ACHIEVEMENTS } from './achievements';
import { GamificationService } from './gamification.service';
import { Permission } from '../common/permissions/permission.decorator';

@UseGuards(JwtAuthGuard)
@Permission('dashboard')
@Controller('gamification')
export class GamificationController {
  constructor(private gamificationService: GamificationService) {}

  @Get('stats')
  getStats(@CurrentUser() user: JwtPayload) {
    return this.gamificationService.getStats(user.sub);
  }

  @Get('achievements')
  async getAchievements(@CurrentUser() user: JwtPayload) {
    const stats = await this.gamificationService.getStats(user.sub);
    const unlocked = new Set(stats.unlockedAchievements);
    return { achievements: ACHIEVEMENTS.map((a) => ({ ...a, unlocked: unlocked.has(a.id) })) };
  }
}
