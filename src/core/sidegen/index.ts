export {
    SIDE_CLUE_MOUNT_PREFIX,
    SideCluesFacade,
    createStoreSideClueStorage,
    createVfsSideClueStorage,
    normalizeSideCluePath,
    type NormalizedSideCluePath,
    type SideClueStorageAdapter,
    type SideClueVfsLike,
    type SideCluesFacadeOptions,
} from './side-clues-facade';

export {
    AGENTIC_SIDE_SESSIONS_KEY,
    DEFAULT_SIDE_SESSION_WATERMARK,
    SIDE_THREAD_PREFIX,
    SideSessionStore,
    toSideThreadId,
    type PersistedSideSessionRecord,
    type PersistedSideSessionStore,
    type SaveSideSessionOptions,
    type SideSessionBranchCheckpoint,
    type SideSessionRollbackOptions,
    type SideSessionRollbackResult,
    type SideSessionStoreOptions,
} from './side-session-store';

export {
    SideGenService,
    type SideCompactionSummarizer,
    type SideGenServiceOptions,
} from './sidegen-service';
