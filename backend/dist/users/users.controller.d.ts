import { JwtPayload } from '../auth/jwt-payload.interface';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';
export declare class UsersController {
    private usersService;
    constructor(usersService: UsersService);
    me(user: JwtPayload): Promise<{
        id: string;
        email: string;
        name: string;
        organizationId: string;
        storeId: string | undefined;
        roles: string[];
        assignedAgentId: string | undefined;
        department: string | undefined;
        active: boolean;
        voiceAccessEnabled: boolean;
    } | null>;
    list(caller: JwtPayload): Promise<{
        id: string;
        email: string;
        name: string;
        organizationId: string;
        storeId: string | undefined;
        roles: string[];
        assignedAgentId: string | undefined;
        department: string | undefined;
        active: boolean;
        voiceAccessEnabled: boolean;
    }[]>;
    create(caller: JwtPayload, dto: CreateUserDto): Promise<{
        user: {
            id: string;
            email: string;
            name: string;
            organizationId: string;
            storeId: string | undefined;
            roles: string[];
            assignedAgentId: string | undefined;
            department: string | undefined;
            active: boolean;
            voiceAccessEnabled: boolean;
        };
        tempPassword: string;
    }>;
    update(caller: JwtPayload, id: string, dto: UpdateUserDto): Promise<{
        id: string;
        email: string;
        name: string;
        organizationId: string;
        storeId: string | undefined;
        roles: string[];
        assignedAgentId: string | undefined;
        department: string | undefined;
        active: boolean;
        voiceAccessEnabled: boolean;
    }>;
    remove(caller: JwtPayload, id: string): Promise<void>;
}
