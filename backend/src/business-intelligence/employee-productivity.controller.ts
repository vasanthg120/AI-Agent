import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { resolveBiDateRange, scopeBiFilters } from './bi-filter.util';
import { BiFilterQueryDto } from './dto/bi-filter-query.dto';
import { EmployeeProductivityService } from './employee-productivity.service';
import { Permission } from '../common/permissions/permission.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Permission('analytics')
@Controller('business-intelligence/employee-productivity')
export class EmployeeProductivityController {
  constructor(private employeeProductivityService: EmployeeProductivityService) {}

  @Get()
  @Roles('owner', 'admin', 'manager', 'consultant')
  overview(@CurrentUser() user: JwtPayload, @Query() query: BiFilterQueryDto) {
    const scoped = scopeBiFilters(user, query);
    const { start, end } = resolveBiDateRange(scoped);
    return this.employeeProductivityService.getOverview(user.organizationId, start, end, scoped);
  }
}
