import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Model } from 'mongoose';
import { AdminAccount, AdminAccountDocument } from './schemas/admin-account.schema';

const SALT_ROUNDS = 10;

@Injectable()
export class AdminAuthService {
  constructor(
    @InjectModel(AdminAccount.name) private adminAccountModel: Model<AdminAccountDocument>,
    private jwtService: JwtService,
  ) {}

  private toPublic(account: AdminAccountDocument) {
    return { id: account._id.toString(), email: account.email, name: account.name, active: account.active };
  }

  async login(email: string, password: string): Promise<{ accessToken: string; admin: ReturnType<AdminAuthService['toPublic']> }> {
    const account = await this.adminAccountModel.findOne({ email: email.toLowerCase().trim() }).exec();
    if (!account || !(await bcrypt.compare(password, account.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (account.active === false) {
      throw new UnauthorizedException('Account disabled');
    }
    const accessToken = this.jwtService.sign({
      sub: account._id.toString(),
      email: account.email,
      isAdminAccount: true,
    });
    return { accessToken, admin: this.toPublic(account) };
  }

  async list() {
    const accounts = await this.adminAccountModel.find().sort({ createdAt: -1 }).exec();
    return accounts.map((a) => this.toPublic(a));
  }

  async create(dto: { email: string; password: string; name: string }) {
    const existing = await this.adminAccountModel.findOne({ email: dto.email.toLowerCase().trim() }).exec();
    if (existing) throw new BadRequestException(`An admin account with email "${dto.email}" already exists.`);
    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    const created = await this.adminAccountModel.create({ email: dto.email, passwordHash, name: dto.name });
    return this.toPublic(created);
  }

  async setActive(id: string, active: boolean, callerId: string) {
    if (id === callerId && !active) {
      throw new BadRequestException("Can't deactivate your own admin account.");
    }
    const updated = await this.adminAccountModel.findByIdAndUpdate(id, { $set: { active } }, { new: true }).exec();
    if (!updated) throw new NotFoundException('Admin account not found');
    return this.toPublic(updated);
  }
}
