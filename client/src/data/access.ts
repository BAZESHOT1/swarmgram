/** Доступ к разделу «Сеть»: PRO/Premium/модератор/администратор. */
import type { User } from './api';

const NETWORK_ROLES = new Set(['pro', 'premium', 'moderator', 'admin']);

export function hasNetworkAccess(user: User | null | undefined): boolean {
  if (!user) return false;
  const role = String(user.role ?? '').toLowerCase();
  const plan = String(user.plan ?? '').toLowerCase();
  return NETWORK_ROLES.has(role) || plan === 'pro' || plan === 'premium';
}
