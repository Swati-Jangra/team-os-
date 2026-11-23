import type { ColumnType, Generated } from 'kysely';

type Id = Generated<string>;
type Ts = Generated<Date>;
type NullableTs = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json = ColumnType<Record<string, unknown>, string | undefined, string>;
type JsonRequired = ColumnType<Record<string, unknown>, string, string>;

export type MemberRole =
  | 'OWNER'
  | 'ADMIN'
  | 'PROJECT_MANAGER'
  | 'TEAM_LEAD'
  | 'DEVELOPER'
  | 'VIEWER'
  | 'GUEST';
export type EmailTokenType = 'VERIFY_EMAIL' | 'PASSWORD_RESET';
export type ActorType = 'USER' | 'AI' | 'SYSTEM';
export type ProjectStatus = 'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'ARCHIVED';
export type MilestoneStatus = 'OPEN' | 'COMPLETED';
export type TaskStatus = 'BACKLOG' | 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' | 'CANCELLED';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
type DateCol = ColumnType<string | null, string | null | undefined, string | null>;

export interface UsersTable {
  id: Id;
  email: string;
  name: string;
  passwordHash: string;
  emailVerifiedAt: NullableTs;
  failedLoginCount: Generated<number>;
  lockedUntil: NullableTs;
  lastLoginAt: NullableTs;
  createdAt: Ts;
  updatedAt: Ts;
  deletedAt: NullableTs;
}

export interface SessionsTable {
  id: Id;
  userId: string;
  tokenHash: string;
  csrfToken: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Ts;
  expiresAt: Date;
  lastUsedAt: Ts;
  revokedAt: NullableTs;
}

export interface EmailTokensTable {
  id: Id;
  userId: string;
  type: EmailTokenType;
  tokenHash: string;
  expiresAt: Date;
  usedAt: NullableTs;
  createdAt: Ts;
}

export interface OrganizationsTable {
  id: Id;
  name: string;
  slug: string;
  settings: Json;
  createdBy: string | null;
  createdAt: Ts;
  updatedAt: Ts;
  deletedAt: NullableTs;
}

export interface OrganizationMembersTable {
  id: Id;
  organizationId: string;
  userId: string;
  role: MemberRole;
  createdAt: Ts;
  updatedAt: Ts;
  deletedAt: NullableTs;
}

export interface WorkspacesTable {
  id: Id;
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  settings: Json;
  createdBy: string | null;
  createdAt: Ts;
  updatedAt: Ts;
  deletedAt: NullableTs;
}

export interface WorkspaceMembersTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  userId: string;
  role: MemberRole;
  createdAt: Ts;
  updatedAt: Ts;
  deletedAt: NullableTs;
}

export interface TeamsTable {
  id: Id;
  organizationId: string;
  name: string;
  description: string | null;
  createdAt: Ts;
  updatedAt: Ts;
  deletedAt: NullableTs;
}

export interface TeamMembersTable {
  id: Id;
  organizationId: string;
  teamId: string;
  userId: string;
  createdAt: Ts;
}

export interface PermissionsTable {
  id: Id;
  key: string;
  description: string | null;
}

export interface RolesTable {
  id: Id;
  organizationId: string | null;
  name: string;
  description: string | null;
  isSystem: Generated<boolean>;
  createdAt: Ts;
}

export interface RolePermissionsTable {
  roleId: string;
  permissionId: string;
}

export interface InvitationsTable {
  id: Id;
  organizationId: string;
  email: string;
  role: MemberRole;
  tokenHash: string;
  invitedById: string;
  workspaceIds: Generated<string[]>;
  expiresAt: Date;
  acceptedAt: NullableTs;
  acceptedById: string | null;
  revokedAt: NullableTs;
  createdAt: Ts;
}

export interface AuditLogsTable {
  id: Id;
  organizationId: string | null;
  workspaceId: string | null;
  actorType: ActorType;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Json;
  requestId: string | null;
  approvalId: string | null;
  ip: string | null;
  createdAt: Ts;
}

export interface OutboxEventsTable {
  id: Id;
  type: string;
  version: Generated<number>;
  organizationId: string | null;
  workspaceId: string | null;
  payload: JsonRequired;
  createdAt: Ts;
  publishedAt: NullableTs;
  attempts: Generated<number>;
  lockedAt: NullableTs;
  lastError: string | null;
}

export interface ProcessedEventsTable {
  consumer: string;
  eventId: string;
  processedAt: Ts;
}

export interface ProjectsTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  key: string;
  name: string;
  description: string | null;
  status: Generated<ProjectStatus>;
  ownerId: string | null;
  startDate: DateCol;
  dueDate: DateCol;
  taskSeq: Generated<number>;
  createdBy: string;
  createdAt: Ts;
  updatedAt: Ts;
  deletedAt: NullableTs;
}

export interface MilestonesTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  projectId: string;
  name: string;
  description: string | null;
  dueDate: DateCol;
  status: Generated<MilestoneStatus>;
  createdAt: Ts;
  updatedAt: Ts;
  deletedAt: NullableTs;
}

export interface TasksTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  projectId: string;
  milestoneId: string | null;
  number: number;
  title: string;
  description: string | null;
  status: Generated<TaskStatus>;
  priority: Generated<TaskPriority>;
  assigneeId: string | null;
  reporterId: string;
  startDate: DateCol;
  dueDate: DateCol;
  estimateHours: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  labels: Generated<string[]>;
  position: Generated<number>;
  completedAt: NullableTs;
  createdAt: Ts;
  updatedAt: Ts;
  deletedAt: NullableTs;
}

export interface TaskDependenciesTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  taskId: string;
  dependsOnTaskId: string;
  createdBy: string;
  createdAt: Ts;
}

export interface CommentsTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  taskId: string;
  authorId: string;
  body: string;
  editedAt: NullableTs;
  createdAt: Ts;
  deletedAt: NullableTs;
}

export interface ActivityEventsTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  projectId: string;
  taskId: string | null;
  actorType: Generated<ActorType>;
  actorId: string | null;
  action: string;
  metadata: Json;
  createdAt: Ts;
}

export type NotificationCategory = 'TASK_ASSIGNED' | 'TASK_COMMENT' | 'TASK_STATUS' | 'TASK_DUE';

export interface NotificationsTable {
  id: Id;
  organizationId: string;
  userId: string;
  category: NotificationCategory;
  title: string;
  body: string | null;
  link: string | null;
  workspaceId: string | null;
  taskId: string | null;
  dedupeKey: string | null;
  readAt: NullableTs;
  createdAt: Ts;
}

export interface NotificationPreferencesTable {
  userId: string;
  category: NotificationCategory;
  inApp: boolean;
  email: boolean;
  updatedAt: Ts;
}

export interface DocumentsTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  projectId: string | null;
  title: string;
  contentHtml: Generated<string>;
  version: Generated<number>;
  createdBy: string;
  updatedBy: string;
  createdAt: Ts;
  updatedAt: Ts;
  deletedAt: NullableTs;
}

export interface DocumentVersionsTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  version: number;
  title: string;
  contentHtml: string;
  createdBy: string;
  createdAt: Ts;
}

export type KnowledgeSourceType = 'DOCUMENT' | 'MEETING';

export interface KnowledgeChunksTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  chunkIndex: number;
  sourceTitle: string;
  heading: string | null;
  content: string;
  /** generated column — never written */
  contentTsv: ColumnType<string, never, never>;
  embedding: number[];
  embeddingModel: string;
  embeddingVersion: string;
  sourceVersion: number;
  createdAt: Ts;
  updatedAt: Ts;
}

export interface AiUsageTable {
  id: Id;
  organizationId: string;
  userId: string | null;
  feature: string;
  provider: string;
  model: string;
  inputTokens: Generated<number>;
  outputTokens: Generated<number>;
  createdAt: Ts;
}

export type MeetingStatus = 'DRAFT' | 'PROCESSING' | 'READY' | 'FAILED';
export type MeetingItemKind = 'DECISION' | 'ACTION_ITEM' | 'BLOCKER';
export type MeetingItemStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface MeetingsTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  projectId: string | null;
  title: string;
  heldAt: NullableTs;
  status: Generated<MeetingStatus>;
  transcript: string | null;
  transcriptSource: 'PASTED' | 'AUDIO' | null;
  audioPath: string | null;
  audioMime: string | null;
  audioBytes: number | null;
  summary: string | null;
  failureReason: string | null;
  createdBy: string;
  createdAt: Ts;
  updatedAt: Ts;
  deletedAt: NullableTs;
}

export type AgentActionStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'EXECUTING' | 'EXECUTED' | 'FAILED' | 'STALE';
export type AgentActionType = 'TASK_UPDATE_DUE' | 'TASK_ASSIGN';
export type AgentName = 'DEPENDENCY_RISK' | 'TASK_MANAGEMENT';
export interface AgentActionsTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  projectId: string;
  agent: AgentName;
  actionType: AgentActionType;
  targetTaskId: string;
  targetVersion: string;
  payload: ColumnType<Record<string, unknown>, string, never>;
  payloadHash: string;
  beforeState: ColumnType<Record<string, unknown>, string, never>;
  afterState: ColumnType<Record<string, unknown>, string, never>;
  rationale: string;
  evidence: ColumnType<unknown[], string | undefined, string>;
  status: Generated<AgentActionStatus>;
  proposedBy: string;
  expiresAt: Ts;
  decidedBy: string | null;
  decidedAt: NullableTs;
  decisionNote: string | null;
  attempts: Generated<number>;
  lastError: string | null;
  executedAt: NullableTs;
  createdAt: Ts;
  updatedAt: Ts;
}

export type IntegrationStatus = 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
export interface IntegrationsTable {
  id: Id;
  organizationId: string;
  provider: 'GITHUB' | 'GOOGLE_CALENDAR' | 'GOOGLE_MAIL';
  status: Generated<IntegrationStatus>;
  accountLogin: string;
  accountId: string;
  scopes: Generated<string>;
  connectedBy: string;
  lastSyncedAt: NullableTs;
  lastError: string | null;
  createdAt: Ts;
  updatedAt: Ts;
  disconnectedAt: NullableTs;
}
export interface IntegrationTokensTable {
  integrationId: string;
  organizationId: string;
  tokenEnc: string;
  updatedAt: Ts;
}
export interface IntegrationReposTable {
  id: Id;
  organizationId: string;
  integrationId: string;
  workspaceId: string;
  projectId: string | null;
  fullName: string;
  externalId: string;
  webhookId: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  webhookSecretEnc: string;
  active: Generated<boolean>;
  syncedUntil: NullableTs;
  lastSyncedAt: NullableTs;
  lastError: string | null;
  createdAt: Ts;
}
export interface ExternalItemsTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  repoId: string;
  kind: 'PULL_REQUEST' | 'ISSUE' | 'COMMIT';
  externalId: string;
  title: string;
  state: 'open' | 'closed' | 'merged' | null;
  url: string;
  authorLogin: string | null;
  headRef: string | null;
  createdExtAt: NullableTs;
  updatedExtAt: NullableTs;
  mergedAt: NullableTs;
  syncedAt: Ts;
}
export interface TaskLinksTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  taskId: string;
  itemId: string;
  source: 'AUTO' | 'MANUAL';
  createdBy: string | null;
  createdAt: Ts;
}
export type WebhookEventStatus = 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED';
export interface WebhookEventsTable {
  id: Id;
  organizationId: string;
  repoId: string;
  deliveryId: string;
  eventType: string;
  status: Generated<WebhookEventStatus>;
  payload: ColumnType<Record<string, unknown>, string, never>;
  error: string | null;
  receivedAt: Ts;
  processedAt: NullableTs;
}
export interface OauthStatesTable {
  stateHash: string;
  organizationId: string;
  userId: string;
  provider: string;
  expiresAt: Date;
  createdAt: Ts;
}

export interface MeetingItemsTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  meetingId: string;
  kind: MeetingItemKind;
  text: string;
  assigneeHint: string | null;
  dueDate: ColumnType<string | null, string | null | undefined, string | null>;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' | null;
  status: Generated<MeetingItemStatus>;
  taskId: string | null;
  decidedBy: string | null;
  decidedAt: NullableTs;
  createdAt: Ts;
}

export interface CalendarSourcesTable {
  id: Id;
  organizationId: string;
  integrationId: string;
  workspaceId: string;
  calendarId: string;
  name: string;
  syncToken: string | null;
  active: Generated<boolean>;
  lastSyncedAt: NullableTs;
  lastError: string | null;
  createdAt: Ts;
}
export interface CalendarEventsTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  sourceId: string;
  externalId: string;
  title: string;
  startsAt: ColumnType<Date, Date | string, Date | string>;
  endsAt: ColumnType<Date, Date | string, Date | string>;
  allDay: Generated<boolean>;
  status: Generated<'confirmed' | 'tentative'>;
  htmlLink: string | null;
  attendeeCount: Generated<number>;
  syncedAt: Ts;
}
export interface MeetingCalendarLinksTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  meetingId: string;
  eventId: string;
  createdBy: string;
  createdAt: Ts;
}
export interface EmailSourcesTable {
  id: Id;
  organizationId: string;
  integrationId: string;
  workspaceId: string;
  projectId: string | null;
  label: string;
  syncedUntil: NullableTs;
  active: Generated<boolean>;
  lastSyncedAt: NullableTs;
  lastError: string | null;
  createdAt: Ts;
}
export interface EmailMessagesTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  sourceId: string;
  externalId: string;
  threadId: string | null;
  subject: string;
  fromAddress: string | null;
  receivedAt: ColumnType<Date, Date | string, Date | string>;
  excerpt: string;
  projectId: string | null;
  linkSource: 'AUTO' | 'MANUAL' | null;
  status: Generated<'RECEIVED' | 'EXTRACTED' | 'FAILED'>;
  summary: string | null;
  failureReason: string | null;
  syncedAt: Ts;
}
export interface EmailItemsTable {
  id: Id;
  organizationId: string;
  workspaceId: string;
  messageId: string;
  kind: 'DECISION' | 'ACTION_ITEM';
  text: string;
  assigneeHint: string | null;
  dueDate: ColumnType<string | null, string | null | undefined, string | null>;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' | null;
  status: Generated<MeetingItemStatus>;
  taskId: string | null;
  decidedBy: string | null;
  decidedAt: NullableTs;
  createdAt: Ts;
}

export interface DB {
  users: UsersTable;
  sessions: SessionsTable;
  emailTokens: EmailTokensTable;
  organizations: OrganizationsTable;
  organizationMembers: OrganizationMembersTable;
  workspaces: WorkspacesTable;
  workspaceMembers: WorkspaceMembersTable;
  teams: TeamsTable;
  teamMembers: TeamMembersTable;
  permissions: PermissionsTable;
  roles: RolesTable;
  rolePermissions: RolePermissionsTable;
  invitations: InvitationsTable;
  auditLogs: AuditLogsTable;
  outboxEvents: OutboxEventsTable;
  processedEvents: ProcessedEventsTable;
  projects: ProjectsTable;
  milestones: MilestonesTable;
  tasks: TasksTable;
  taskDependencies: TaskDependenciesTable;
  comments: CommentsTable;
  activityEvents: ActivityEventsTable;
  notifications: NotificationsTable;
  notificationPreferences: NotificationPreferencesTable;
  documents: DocumentsTable;
  documentVersions: DocumentVersionsTable;
  knowledgeChunks: KnowledgeChunksTable;
  aiUsage: AiUsageTable;
  meetings: MeetingsTable;
  meetingItems: MeetingItemsTable;
  agentActions: AgentActionsTable;
  integrations: IntegrationsTable;
  integrationTokens: IntegrationTokensTable;
  integrationRepos: IntegrationReposTable;
  externalItems: ExternalItemsTable;
  taskLinks: TaskLinksTable;
  webhookEvents: WebhookEventsTable;
  oauthStates: OauthStatesTable;
  calendarSources: CalendarSourcesTable;
  calendarEvents: CalendarEventsTable;
  meetingCalendarLinks: MeetingCalendarLinksTable;
  emailSources: EmailSourcesTable;
  emailMessages: EmailMessagesTable;
  emailItems: EmailItemsTable;
}
