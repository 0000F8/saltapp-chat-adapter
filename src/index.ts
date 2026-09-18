export { SaltAdapter, createSaltAdapter } from "./adapter";
export type {
  SaltAdapterConfig,
  SaltCardInteractionWebhookBody,
  SaltDeliveryMode,
  SaltMessageWebhookBody,
  SaltRawChatMeta,
  SaltRawMessage,
  SaltRawSender,
  SaltThreadId,
  SaltWebhookBody,
} from "./types";

export { channelIdFromThreadId, decodeThreadId, encodeThreadId } from "./thread-id";
export { verifySaltSignature, type VerifySaltSignatureOptions } from "./signature";
export {
  SALT_ACTION_ID_MAX_LENGTH,
  decodeSaltActionId,
  encodeSaltActionId,
  sanitizeSaltActionId,
} from "./action-id";
export {
  SALT_CARD_LIMITS,
  cardElementToSaltBlocks,
  type SaltButtonBlockElement,
  type SaltCardBlock,
  type SaltCardBlocks,
} from "./cards";
export {
  createSaltExtraRest,
  type SaltExtraRestClient,
  type SaltExtraRestOptions,
  type SaltReactionResponse,
  type SaltReactionsSummary,
} from "./salt-rest";
export {
  MIN_SOCKET_SDK_VERSION,
  assertSocketModeSupported,
  detectSaltAgentSdkSocketClient,
  getInstalledSaltAgentSdkVersion,
  isAtLeast,
  socketModeUnavailableError,
} from "./socket";
