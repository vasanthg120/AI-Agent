import { ConfigService } from '@nestjs/config';
import { Strategy } from 'passport-jwt';
import { OrganizationsService } from '../../organizations/organizations.service';
import { UsersService } from '../../users/users.service';
import { JwtPayload } from '../jwt-payload.interface';
declare const JwtStrategy_base: new (...args: any[]) => Strategy;
export declare class JwtStrategy extends JwtStrategy_base {
    private usersService;
    private organizationsService;
    constructor(config: ConfigService, usersService: UsersService, organizationsService: OrganizationsService);
    validate(payload: JwtPayload): Promise<JwtPayload>;
}
export {};
