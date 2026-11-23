import { canonicalJson, sha256Hex } from './crypto';

/** What an approval is bound to: action type + target + exact payload. */
export function actionHash(parts: { actionType: string; targetTaskId: string; payload: unknown }): string {
  return sha256Hex(canonicalJson(parts));
}
