import { IsBoolean, IsIn } from 'class-validator';

export class SetConversationFlagDto {
  @IsIn(['pinned', 'favorite', 'archived']) flag: 'pinned' | 'favorite' | 'archived';
  @IsBoolean() value: boolean;
}
