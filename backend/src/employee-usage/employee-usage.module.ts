import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EmployeeUsageController } from './employee-usage.controller';
import { EmployeeUsageService } from './employee-usage.service';
import { EmployeeSignIn, EmployeeSignInSchema } from './schemas/employee-sign-in.schema';
import { EmployeeUsageHour, EmployeeUsageHourSchema } from './schemas/employee-usage-hour.schema';

// Measured active time in HaiVE and on calls, and sign-ins (see EmployeeUsageService).
// Depends on nothing but the database, so AuthModule and TeamActivityModule can both use it.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EmployeeUsageHour.name, schema: EmployeeUsageHourSchema },
      { name: EmployeeSignIn.name, schema: EmployeeSignInSchema },
    ]),
  ],
  controllers: [EmployeeUsageController],
  providers: [EmployeeUsageService],
  exports: [EmployeeUsageService],
})
export class EmployeeUsageModule {}
