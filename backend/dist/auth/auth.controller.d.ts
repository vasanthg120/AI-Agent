import type { Request } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { AcceptInvitationDto, VerifyInvitationDto } from './dto/invitation.dto';
import { JwtPayload } from './jwt-payload.interface';
export declare class AuthController {
    private authService;
    constructor(authService: AuthService);
    register(dto: RegisterDto, req: Request): Promise<{
        accessToken: string;
    }>;
    login(dto: LoginDto, req: Request): Promise<import("./auth.service").LoginResult>;
    verifyOtp(dto: VerifyOtpDto): Promise<{
        verified: boolean;
    }>;
    resendOtp(dto: ResendOtpDto): Promise<{
        sent: boolean;
    }>;
    forgotPassword(dto: ForgotPasswordDto): Promise<{
        maskedEmail: string;
    }>;
    resetPassword(dto: ResetPasswordDto): Promise<{
        success: boolean;
    }>;
    verifyInvitation(dto: VerifyInvitationDto): Promise<{
        email: string;
        name: string;
        businessName: string;
    }>;
    acceptInvitation(dto: AcceptInvitationDto, req: Request): Promise<{
        accessToken: string;
    }>;
    changePassword(user: JwtPayload, dto: ChangePasswordDto, req: Request): Promise<{
        success: boolean;
    }>;
    logout(user: JwtPayload): Promise<{
        success: boolean;
    }>;
}
