import {
  startRegistration,
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/browser';
import { apiSend } from './api';

export const passkeySupported = (): boolean => browserSupportsWebAuthn();

/** Register a new passkey for the signed-in user (attestation ceremony). */
export async function passkeyRegister(name: string, csrfToken: string | null): Promise<void> {
  const optionsJSON = await apiSend<PublicKeyCredentialCreationOptionsJSON>(
    'POST',
    '/auth/passkeys/register/options',
    {},
    csrfToken,
  );
  const response = await startRegistration({ optionsJSON });
  await apiSend('POST', '/auth/passkeys/register/verify', { response, name }, csrfToken);
}
