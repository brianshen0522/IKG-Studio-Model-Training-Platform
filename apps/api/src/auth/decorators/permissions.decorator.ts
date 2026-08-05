import { SetMetadata } from '@nestjs/common';
import type { PermissionCode } from '../permission.map';

export const PERMISSIONS_KEY = 'permissions';
export const Permissions = (...perms: PermissionCode[]) => SetMetadata(PERMISSIONS_KEY, perms);
