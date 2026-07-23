import { GraphQLResolveInfo, GraphQLScalarType, GraphQLScalarTypeConfig } from 'graphql';
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type RequireFields<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  Date: { input: any; output: any; }
  Timestamp: { input: any; output: any; }
};

export type ChatResponse = {
  __typename?: 'ChatResponse';
  requestId?: Maybe<Scalars['String']['output']>;
  threadId?: Maybe<Scalars['String']['output']>;
};

export type ControllerInstance = {
  __typename?: 'ControllerInstance';
  controllerName: Scalars['String']['output'];
  createdAt: Scalars['Timestamp']['output'];
  id: Scalars['ID']['output'];
  isMaster?: Maybe<Scalars['Boolean']['output']>;
  lastSeenAt?: Maybe<Scalars['Timestamp']['output']>;
  status: Scalars['String']['output'];
  updatedAt: Scalars['Timestamp']['output'];
};

export type InitUnsTopic = {
  topic?: InputMaybe<Scalars['String']['input']>;
};

export type InsertUnsNode = {
  apiDescription?: InputMaybe<Scalars['String']['input']>;
  apiEndpoint?: InputMaybe<Scalars['String']['input']>;
  apiHost?: InputMaybe<Scalars['String']['input']>;
  apiMethod?: InputMaybe<Scalars['String']['input']>;
  apiSwaggerEndpoint?: InputMaybe<Scalars['String']['input']>;
  asset?: InputMaybe<Scalars['String']['input']>;
  attributeNeedsPersistance?: InputMaybe<Scalars['Boolean']['input']>;
  attributeTags?: InputMaybe<Array<InputMaybe<Scalars['String']['input']>>>;
  attributeTimestamp?: InputMaybe<Scalars['Timestamp']['input']>;
  attributeType?: InputMaybe<UnsAttributeType>;
  dataGroup?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  fullTopic?: InputMaybe<Scalars['String']['input']>;
  objectId?: InputMaybe<Scalars['String']['input']>;
  objectType?: InputMaybe<Scalars['String']['input']>;
  parent: Scalars['Int']['input'];
  processName?: InputMaybe<Scalars['String']['input']>;
  processVersion?: InputMaybe<Scalars['String']['input']>;
  type?: InputMaybe<UnsNodeType>;
  unsNode?: InputMaybe<Scalars['String']['input']>;
};

export type InsertUser = {
  accessRules?: InputMaybe<Array<InputMaybe<Scalars['String']['input']>>>;
  email?: InputMaybe<Scalars['String']['input']>;
  password?: InputMaybe<Scalars['String']['input']>;
  roles?: InputMaybe<Array<InputMaybe<UserRoleType>>>;
};

export type Mutation = {
  __typename?: 'Mutation';
  AddUnsNode?: Maybe<Scalars['Int']['output']>;
  ChangeUserPassword?: Maybe<Scalars['Boolean']['output']>;
  ChatDeleteThread?: Maybe<Scalars['Boolean']['output']>;
  ChatPrompt?: Maybe<ChatResponse>;
  ClearRttDeployStatus?: Maybe<Scalars['Boolean']['output']>;
  CreateUser?: Maybe<Scalars['Boolean']['output']>;
  DeleteRttNode?: Maybe<Scalars['Boolean']['output']>;
  DeleteRttNodeInstance?: Maybe<Scalars['Boolean']['output']>;
  DeleteRttNodeVersion?: Maybe<Scalars['Boolean']['output']>;
  DeleteUnsNode?: Maybe<Scalars['Boolean']['output']>;
  DeployRttNode?: Maybe<Scalars['Boolean']['output']>;
  KillRttProcess?: Maybe<Scalars['Boolean']['output']>;
  MigrateRttNodeInstances?: Maybe<RttMigrationResult>;
  MintServiceAccessToken?: Maybe<Scalars['String']['output']>;
  ModifyUnsNode?: Maybe<Scalars['Boolean']['output']>;
  PurgeAssetDescriptions?: Maybe<Scalars['Int']['output']>;
  PurgeAttributeTags?: Maybe<Scalars['Int']['output']>;
  /** Purge all nodes that are older the maxAge in hours */
  PurgeOldNodes?: Maybe<Scalars['Boolean']['output']>;
  PurgeUnsNodes?: Maybe<Scalars['Int']['output']>;
  RebuildRttNodeVersion?: Maybe<Scalars['Boolean']['output']>;
  SaveRttConfigVersion?: Maybe<Scalars['String']['output']>;
  SetRttNodeConfigForVersion?: Maybe<Scalars['Boolean']['output']>;
  StartRttNodeVersion?: Maybe<Scalars['Boolean']['output']>;
  StopRttNodeVersion?: Maybe<Scalars['Boolean']['output']>;
  UpdateUser?: Maybe<Scalars['Boolean']['output']>;
};


export type MutationAddUnsNodeArgs = {
  node?: InputMaybe<InsertUnsNode>;
};


export type MutationChangeUserPasswordArgs = {
  user?: InputMaybe<UpdateUserPassword>;
};


export type MutationChatDeleteThreadArgs = {
  threadId?: InputMaybe<Scalars['String']['input']>;
};


export type MutationChatPromptArgs = {
  message?: InputMaybe<Scalars['String']['input']>;
  threadId?: InputMaybe<Scalars['String']['input']>;
};


export type MutationClearRttDeployStatusArgs = {
  controllerName?: InputMaybe<Scalars['String']['input']>;
  rttNode?: InputMaybe<Scalars['String']['input']>;
};


export type MutationCreateUserArgs = {
  user?: InputMaybe<InsertUser>;
};


export type MutationDeleteRttNodeArgs = {
  controllerName?: InputMaybe<Scalars['String']['input']>;
  rttNode?: InputMaybe<Scalars['String']['input']>;
};


export type MutationDeleteRttNodeInstanceArgs = {
  controllerName?: InputMaybe<Scalars['String']['input']>;
  instanceId?: InputMaybe<Scalars['String']['input']>;
  rttNode?: InputMaybe<Scalars['String']['input']>;
  version?: InputMaybe<Scalars['String']['input']>;
};


export type MutationDeleteRttNodeVersionArgs = {
  controllerName?: InputMaybe<Scalars['String']['input']>;
  rttNode?: InputMaybe<Scalars['String']['input']>;
  version?: InputMaybe<Scalars['String']['input']>;
};


export type MutationDeleteUnsNodeArgs = {
  id?: InputMaybe<Scalars['Int']['input']>;
};


export type MutationDeployRttNodeArgs = {
  controllerName?: InputMaybe<Scalars['String']['input']>;
  rttNode?: InputMaybe<Scalars['String']['input']>;
  tag?: InputMaybe<Scalars['String']['input']>;
};


export type MutationKillRttProcessArgs = {
  controllerName?: InputMaybe<Scalars['String']['input']>;
  pmId?: InputMaybe<Scalars['Int']['input']>;
};


export type MutationMigrateRttNodeInstancesArgs = {
  rttNode?: InputMaybe<Scalars['String']['input']>;
  sourceController?: InputMaybe<Scalars['String']['input']>;
  targetController?: InputMaybe<Scalars['String']['input']>;
};


export type MutationMintServiceAccessTokenArgs = {
  accessTTL?: InputMaybe<Scalars['Int']['input']>;
};


export type MutationModifyUnsNodeArgs = {
  id?: InputMaybe<Scalars['Int']['input']>;
  node?: InputMaybe<UpdateUnsNode>;
};


export type MutationPurgeAssetDescriptionsArgs = {
  pathPrefix?: InputMaybe<Scalars['String']['input']>;
};


export type MutationPurgeAttributeTagsArgs = {
  pathPrefix?: InputMaybe<Scalars['String']['input']>;
};


export type MutationPurgeOldNodesArgs = {
  maxAge?: InputMaybe<Scalars['Int']['input']>;
};


export type MutationPurgeUnsNodesArgs = {
  pathPrefix?: InputMaybe<Scalars['String']['input']>;
  type: UnsNodeType;
};


export type MutationRebuildRttNodeVersionArgs = {
  controllerName?: InputMaybe<Scalars['String']['input']>;
  rttNode?: InputMaybe<Scalars['String']['input']>;
  version?: InputMaybe<Scalars['String']['input']>;
};


export type MutationSaveRttConfigVersionArgs = {
  configuration?: InputMaybe<Scalars['String']['input']>;
  controllerName?: InputMaybe<Scalars['String']['input']>;
  instanceId?: InputMaybe<Scalars['String']['input']>;
  label?: InputMaybe<Scalars['String']['input']>;
  rttNode?: InputMaybe<Scalars['String']['input']>;
  version?: InputMaybe<Scalars['String']['input']>;
};


export type MutationSetRttNodeConfigForVersionArgs = {
  configuration?: InputMaybe<Scalars['String']['input']>;
  controllerName?: InputMaybe<Scalars['String']['input']>;
  instanceId?: InputMaybe<Scalars['String']['input']>;
  rttNode?: InputMaybe<Scalars['String']['input']>;
  version?: InputMaybe<Scalars['String']['input']>;
};


export type MutationStartRttNodeVersionArgs = {
  controllerName?: InputMaybe<Scalars['String']['input']>;
  instanceId?: InputMaybe<Scalars['String']['input']>;
  rttNode?: InputMaybe<Scalars['String']['input']>;
  version?: InputMaybe<Scalars['String']['input']>;
};


export type MutationStopRttNodeVersionArgs = {
  controllerName?: InputMaybe<Scalars['String']['input']>;
  instanceId?: InputMaybe<Scalars['String']['input']>;
  rttNode?: InputMaybe<Scalars['String']['input']>;
  version?: InputMaybe<Scalars['String']['input']>;
};


export type MutationUpdateUserArgs = {
  user?: InputMaybe<UpdateUser>;
};

/** name: uns-datahub */
export type Query = {
  __typename?: 'Query';
  GetAssets?: Maybe<Array<Maybe<UnsAssetSummary>>>;
  GetAttributes?: Maybe<Array<Maybe<UnsAttributeSummary>>>;
  GetControllerInstances?: Maybe<Array<Maybe<ControllerInstance>>>;
  GetRepositories?: Maybe<Array<Maybe<Repository>>>;
  GetRepository?: Maybe<Repository>;
  GetRttConfigSchema?: Maybe<Scalars['String']['output']>;
  GetRttConfigTemplate?: Maybe<Scalars['String']['output']>;
  GetRttConfigTemplates?: Maybe<Array<Maybe<Scalars['String']['output']>>>;
  GetRttConfigVersion?: Maybe<Scalars['String']['output']>;
  GetRttNodeConfig?: Maybe<Scalars['String']['output']>;
  GetRttNodes?: Maybe<Array<Maybe<RttNode>>>;
  GetRttProcessStatus?: Maybe<RttProcessStatus>;
  GetTags?: Maybe<Array<Maybe<Scalars['String']['output']>>>;
  GetTreeStructure?: Maybe<Array<Maybe<TreeStructure>>>;
  GetUnsNodes?: Maybe<Array<Maybe<UnsNode>>>;
  GetUsers?: Maybe<Array<Maybe<User>>>;
  ListRttConfigVersions?: Maybe<Array<Maybe<RttConfigVersion>>>;
  ListRttProcesses?: Maybe<Array<Maybe<RttProcess>>>;
  QuestDBMappings?: Maybe<Array<Maybe<QuestDbMapping>>>;
};


/** name: uns-datahub */
export type QueryGetAssetsArgs = {
  pathPrefix?: InputMaybe<Scalars['String']['input']>;
};


/** name: uns-datahub */
export type QueryGetAttributesArgs = {
  pathPrefix?: InputMaybe<Scalars['String']['input']>;
};


/** name: uns-datahub */
export type QueryGetRepositoryArgs = {
  repoId?: InputMaybe<Scalars['String']['input']>;
};


/** name: uns-datahub */
export type QueryGetRttConfigSchemaArgs = {
  controllerName?: InputMaybe<Scalars['String']['input']>;
  rttNode?: InputMaybe<Scalars['String']['input']>;
  version?: InputMaybe<Scalars['String']['input']>;
};


/** name: uns-datahub */
export type QueryGetRttConfigTemplateArgs = {
  rttNode?: InputMaybe<Scalars['String']['input']>;
  templateName?: InputMaybe<Scalars['String']['input']>;
  version?: InputMaybe<Scalars['String']['input']>;
};


/** name: uns-datahub */
export type QueryGetRttConfigTemplatesArgs = {
  rttNode?: InputMaybe<Scalars['String']['input']>;
  version?: InputMaybe<Scalars['String']['input']>;
};


/** name: uns-datahub */
export type QueryGetRttConfigVersionArgs = {
  controllerName?: InputMaybe<Scalars['String']['input']>;
  instanceId?: InputMaybe<Scalars['String']['input']>;
  rttNode?: InputMaybe<Scalars['String']['input']>;
  version?: InputMaybe<Scalars['String']['input']>;
  versionId?: InputMaybe<Scalars['String']['input']>;
};


/** name: uns-datahub */
export type QueryGetRttNodeConfigArgs = {
  controllerName?: InputMaybe<Scalars['String']['input']>;
  instanceId?: InputMaybe<Scalars['String']['input']>;
  rttNode?: InputMaybe<Scalars['String']['input']>;
  version?: InputMaybe<Scalars['String']['input']>;
};


/** name: uns-datahub */
export type QueryGetRttNodesArgs = {
  controllerName?: InputMaybe<Scalars['String']['input']>;
};


/** name: uns-datahub */
export type QueryGetRttProcessStatusArgs = {
  controllerName?: InputMaybe<Scalars['String']['input']>;
  processName?: InputMaybe<Scalars['String']['input']>;
  rttNode?: InputMaybe<Scalars['String']['input']>;
  version?: InputMaybe<Scalars['String']['input']>;
};


/** name: uns-datahub */
export type QueryGetTreeStructureArgs = {
  attributeTags?: InputMaybe<Array<InputMaybe<Scalars['String']['input']>>>;
};


/** name: uns-datahub */
export type QueryListRttConfigVersionsArgs = {
  controllerName?: InputMaybe<Scalars['String']['input']>;
  instanceId?: InputMaybe<Scalars['String']['input']>;
  rttNode?: InputMaybe<Scalars['String']['input']>;
  version?: InputMaybe<Scalars['String']['input']>;
};


/** name: uns-datahub */
export type QueryListRttProcessesArgs = {
  controllerName?: InputMaybe<Scalars['String']['input']>;
  rttNode?: InputMaybe<Scalars['String']['input']>;
};

export type QuestDbMapping = {
  __typename?: 'QuestDbMapping';
  dataGroup?: Maybe<Scalars['String']['output']>;
  packageName?: Maybe<Scalars['String']['output']>;
  processName?: Maybe<Scalars['String']['output']>;
  questdbUrl?: Maybe<Scalars['String']['output']>;
  suffix?: Maybe<Scalars['String']['output']>;
  tableName?: Maybe<Scalars['String']['output']>;
  tablePrefix?: Maybe<Scalars['String']['output']>;
  topicPrefix?: Maybe<Scalars['String']['output']>;
  updatedAt?: Maybe<Scalars['Timestamp']['output']>;
  version?: Maybe<Scalars['String']['output']>;
};

export type Repository = {
  __typename?: 'Repository';
  name?: Maybe<Scalars['String']['output']>;
  tags?: Maybe<Array<Maybe<Scalars['String']['output']>>>;
};

export type RttConfigVersion = {
  __typename?: 'RttConfigVersion';
  appTag?: Maybe<Scalars['String']['output']>;
  createdAt?: Maybe<Scalars['Timestamp']['output']>;
  createdBy?: Maybe<Scalars['String']['output']>;
  id?: Maybe<Scalars['ID']['output']>;
  label?: Maybe<Scalars['String']['output']>;
  schemaHash?: Maybe<Scalars['String']['output']>;
};

export type RttInstance = {
  __typename?: 'RttInstance';
  configAvailable?: Maybe<Scalars['Boolean']['output']>;
  handoverEnabled?: Maybe<Scalars['Boolean']['output']>;
  handoverState?: Maybe<Scalars['String']['output']>;
  handoverUpdatedAt?: Maybe<Scalars['Timestamp']['output']>;
  id?: Maybe<Scalars['String']['output']>;
  instanceMode?: Maybe<Scalars['String']['output']>;
  processName?: Maybe<Scalars['String']['output']>;
  processes?: Maybe<Array<Maybe<RttProcess>>>;
};

export type RttMigrationInstance = {
  __typename?: 'RttMigrationInstance';
  instanceId?: Maybe<Scalars['String']['output']>;
  processName?: Maybe<Scalars['String']['output']>;
  reason?: Maybe<Scalars['String']['output']>;
  status?: Maybe<Scalars['String']['output']>;
  version?: Maybe<Scalars['String']['output']>;
};

export type RttMigrationResult = {
  __typename?: 'RttMigrationResult';
  instances?: Maybe<Array<Maybe<RttMigrationInstance>>>;
  message?: Maybe<Scalars['String']['output']>;
  ok?: Maybe<Scalars['Boolean']['output']>;
};

export type RttNode = {
  __typename?: 'RttNode';
  author?: Maybe<Scalars['String']['output']>;
  deployMessage?: Maybe<Scalars['String']['output']>;
  deployStatus?: Maybe<Scalars['String']['output']>;
  deployTag?: Maybe<Scalars['String']['output']>;
  deployedVersions?: Maybe<Array<Maybe<Scalars['String']['output']>>>;
  description?: Maybe<Scalars['String']['output']>;
  lastErrLog?: Maybe<Scalars['String']['output']>;
  lastLog?: Maybe<Scalars['String']['output']>;
  latestDeployedVersion?: Maybe<Scalars['String']['output']>;
  memory?: Maybe<Scalars['Int']['output']>;
  pid?: Maybe<Scalars['Int']['output']>;
  processes?: Maybe<Array<Maybe<RttProcess>>>;
  restarts?: Maybe<Scalars['Int']['output']>;
  rttNode?: Maybe<Scalars['String']['output']>;
  runningVersion?: Maybe<Scalars['String']['output']>;
  status?: Maybe<Scalars['String']['output']>;
  topics?: Maybe<Array<Maybe<Scalars['String']['output']>>>;
  uptime?: Maybe<Scalars['Int']['output']>;
  version?: Maybe<Scalars['String']['output']>;
  versions?: Maybe<Array<Maybe<RttVersion>>>;
};

export type RttProcess = {
  __typename?: 'RttProcess';
  instanceId?: Maybe<Scalars['String']['output']>;
  memory?: Maybe<Scalars['Int']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  pid?: Maybe<Scalars['Int']['output']>;
  pmId?: Maybe<Scalars['Int']['output']>;
  restarts?: Maybe<Scalars['Int']['output']>;
  status?: Maybe<Scalars['String']['output']>;
  uptime?: Maybe<Scalars['Int']['output']>;
  version?: Maybe<Scalars['String']['output']>;
};

export type RttProcessStatus = {
  __typename?: 'RttProcessStatus';
  active?: Maybe<Scalars['Boolean']['output']>;
  handoverState?: Maybe<Scalars['String']['output']>;
  handoverUpdatedAt?: Maybe<Scalars['Timestamp']['output']>;
  heapTotal?: Maybe<Scalars['Int']['output']>;
  heapUsed?: Maybe<Scalars['Int']['output']>;
  instances?: Maybe<Array<Maybe<RttProxyInstanceStatus>>>;
  packageName?: Maybe<Scalars['String']['output']>;
  processName?: Maybe<Scalars['String']['output']>;
  processVersion?: Maybe<Scalars['String']['output']>;
};

export type RttProxyInstanceStatus = {
  __typename?: 'RttProxyInstanceStatus';
  alive?: Maybe<Scalars['Boolean']['output']>;
  apiEndpointsCount?: Maybe<Scalars['Int']['output']>;
  lastUpdatedAt?: Maybe<Scalars['Timestamp']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  publishedMessageBytes?: Maybe<Scalars['Int']['output']>;
  publishedMessageCount?: Maybe<Scalars['Int']['output']>;
  publisherActive?: Maybe<Scalars['Boolean']['output']>;
  subscribedMessageBytes?: Maybe<Scalars['Int']['output']>;
  subscribedMessageCount?: Maybe<Scalars['Int']['output']>;
  subscriberActive?: Maybe<Scalars['Boolean']['output']>;
  topicsCount?: Maybe<Scalars['Int']['output']>;
  uptimeMinutes?: Maybe<Scalars['Float']['output']>;
};

export type RttVersion = {
  __typename?: 'RttVersion';
  instances?: Maybe<Array<Maybe<RttInstance>>>;
  isInstalled?: Maybe<Scalars['Boolean']['output']>;
  version?: Maybe<Scalars['String']['output']>;
};

export type TreeStructure = {
  __typename?: 'TreeStructure';
  apiCatchallBase?: Maybe<Scalars['String']['output']>;
  apiCatchallBasePath?: Maybe<Scalars['String']['output']>;
  apiCatchallSwaggerPath?: Maybe<Scalars['String']['output']>;
  apiCatchallSwaggerUrl?: Maybe<Scalars['String']['output']>;
  apiDescription?: Maybe<Scalars['String']['output']>;
  apiEndpoint?: Maybe<Scalars['String']['output']>;
  apiHost?: Maybe<Scalars['String']['output']>;
  apiMethod?: Maybe<Scalars['String']['output']>;
  apiProxyHost?: Maybe<Scalars['String']['output']>;
  apiSwaggerEndpoint?: Maybe<Scalars['String']['output']>;
  asset?: Maybe<Scalars['String']['output']>;
  attributeNeedsPersistance?: Maybe<Scalars['Boolean']['output']>;
  attributeTags?: Maybe<Array<Maybe<Scalars['String']['output']>>>;
  attributeTimestamp?: Maybe<Scalars['Timestamp']['output']>;
  attributeType?: Maybe<UnsAttributeType>;
  children?: Maybe<Array<Maybe<TreeStructure>>>;
  dataGroup?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  fullTopic?: Maybe<Scalars['String']['output']>;
  id?: Maybe<Scalars['Int']['output']>;
  objectId?: Maybe<Scalars['String']['output']>;
  objectType?: Maybe<Scalars['String']['output']>;
  parent?: Maybe<Scalars['Int']['output']>;
  processName?: Maybe<Scalars['String']['output']>;
  processVersion?: Maybe<Scalars['String']['output']>;
  questdbTableNames?: Maybe<Array<Maybe<Scalars['String']['output']>>>;
  questdbTablePrefix?: Maybe<Scalars['String']['output']>;
  questdbUrl?: Maybe<Scalars['String']['output']>;
  type?: Maybe<UnsNodeType>;
  unsNode?: Maybe<Scalars['String']['output']>;
};

export type UnsAssetSummary = {
  __typename?: 'UnsAssetSummary';
  asset?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  objectId?: Maybe<Scalars['String']['output']>;
  objectType?: Maybe<Scalars['String']['output']>;
  path?: Maybe<Scalars['String']['output']>;
};

export type UnsAttributeSummary = {
  __typename?: 'UnsAttributeSummary';
  attributeType?: Maybe<Scalars['String']['output']>;
  dataGroup?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  objectId?: Maybe<Scalars['String']['output']>;
  objectType?: Maybe<Scalars['String']['output']>;
  path?: Maybe<Scalars['String']['output']>;
};

export enum UnsAttributeType {
  Api = 'Api',
  Data = 'Data',
  Event = 'Event',
  Table = 'Table'
}

export type UnsNode = {
  __typename?: 'UnsNode';
  apiDescription?: Maybe<Scalars['String']['output']>;
  apiEndpoint?: Maybe<Scalars['String']['output']>;
  apiHost?: Maybe<Scalars['String']['output']>;
  apiMethod?: Maybe<Scalars['String']['output']>;
  apiProxyHost?: Maybe<Scalars['String']['output']>;
  apiSwaggerEndpoint?: Maybe<Scalars['String']['output']>;
  asset?: Maybe<Scalars['String']['output']>;
  attributeNeedsPersistance?: Maybe<Scalars['Boolean']['output']>;
  attributeTags?: Maybe<Array<Maybe<Scalars['String']['output']>>>;
  attributeTimestamp?: Maybe<Scalars['Timestamp']['output']>;
  attributeType?: Maybe<UnsAttributeType>;
  dataGroup?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  fullTopic?: Maybe<Scalars['String']['output']>;
  id?: Maybe<Scalars['Int']['output']>;
  objectId?: Maybe<Scalars['String']['output']>;
  objectType?: Maybe<Scalars['String']['output']>;
  parent?: Maybe<Scalars['Int']['output']>;
  processName?: Maybe<Scalars['String']['output']>;
  processVersion?: Maybe<Scalars['String']['output']>;
  type?: Maybe<UnsNodeType>;
  unsNode?: Maybe<Scalars['String']['output']>;
};

export enum UnsNodeType {
  Asset = 'Asset',
  Attribute = 'Attribute',
  DynamicTopic = 'DynamicTopic',
  ObjectId = 'ObjectId',
  ObjectType = 'ObjectType',
  Topic = 'Topic'
}

export type UpdateUnsNode = {
  apiDescription?: InputMaybe<Scalars['String']['input']>;
  apiEndpoint?: InputMaybe<Scalars['String']['input']>;
  apiHost?: InputMaybe<Scalars['String']['input']>;
  apiMethod?: InputMaybe<Scalars['String']['input']>;
  apiSwaggerEndpoint?: InputMaybe<Scalars['String']['input']>;
  asset?: InputMaybe<Scalars['String']['input']>;
  attributeNeedsPersistance?: InputMaybe<Scalars['Boolean']['input']>;
  attributeTags?: InputMaybe<Array<InputMaybe<Scalars['String']['input']>>>;
  attributeTimestamp?: InputMaybe<Scalars['Timestamp']['input']>;
  attributeType?: InputMaybe<UnsAttributeType>;
  dataGroup?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  fullTopic?: InputMaybe<Scalars['String']['input']>;
  objectId?: InputMaybe<Scalars['String']['input']>;
  objectType?: InputMaybe<Scalars['String']['input']>;
  parent?: InputMaybe<Scalars['Int']['input']>;
  processName?: InputMaybe<Scalars['String']['input']>;
  processVersion?: InputMaybe<Scalars['String']['input']>;
  type?: InputMaybe<UnsNodeType>;
  unsNode?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateUser = {
  accessRules?: InputMaybe<Array<InputMaybe<Scalars['String']['input']>>>;
  id?: InputMaybe<Scalars['String']['input']>;
  roles?: InputMaybe<Array<InputMaybe<UserRoleType>>>;
};

export type UpdateUserPassword = {
  id?: InputMaybe<Scalars['String']['input']>;
  password?: InputMaybe<Scalars['String']['input']>;
};

export type User = {
  __typename?: 'User';
  accessRules?: Maybe<Array<Maybe<Scalars['String']['output']>>>;
  email?: Maybe<Scalars['String']['output']>;
  id?: Maybe<Scalars['String']['output']>;
  roles?: Maybe<Array<Maybe<UserRoleType>>>;
};

export enum UserRoleType {
  Admin = 'admin',
  Operator = 'operator',
  User = 'user'
}



export type ResolverTypeWrapper<T> = Promise<T> | T;


export type ResolverWithResolve<TResult, TParent, TContext, TArgs> = {
  resolve: ResolverFn<TResult, TParent, TContext, TArgs>;
};
export type Resolver<TResult, TParent = {}, TContext = {}, TArgs = {}> = ResolverFn<TResult, TParent, TContext, TArgs> | ResolverWithResolve<TResult, TParent, TContext, TArgs>;

export type ResolverFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => Promise<TResult> | TResult;

export type SubscriptionSubscribeFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => AsyncIterable<TResult> | Promise<AsyncIterable<TResult>>;

export type SubscriptionResolveFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;

export interface SubscriptionSubscriberObject<TResult, TKey extends string, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<{ [key in TKey]: TResult }, TParent, TContext, TArgs>;
  resolve?: SubscriptionResolveFn<TResult, { [key in TKey]: TResult }, TContext, TArgs>;
}

export interface SubscriptionResolverObject<TResult, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<any, TParent, TContext, TArgs>;
  resolve: SubscriptionResolveFn<TResult, any, TContext, TArgs>;
}

export type SubscriptionObject<TResult, TKey extends string, TParent, TContext, TArgs> =
  | SubscriptionSubscriberObject<TResult, TKey, TParent, TContext, TArgs>
  | SubscriptionResolverObject<TResult, TParent, TContext, TArgs>;

export type SubscriptionResolver<TResult, TKey extends string, TParent = {}, TContext = {}, TArgs = {}> =
  | ((...args: any[]) => SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>)
  | SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>;

export type TypeResolveFn<TTypes, TParent = {}, TContext = {}> = (
  parent: TParent,
  context: TContext,
  info: GraphQLResolveInfo
) => Maybe<TTypes> | Promise<Maybe<TTypes>>;

export type IsTypeOfResolverFn<T = {}, TContext = {}> = (obj: T, context: TContext, info: GraphQLResolveInfo) => boolean | Promise<boolean>;

export type NextResolverFn<T> = () => Promise<T>;

export type DirectiveResolverFn<TResult = {}, TParent = {}, TContext = {}, TArgs = {}> = (
  next: NextResolverFn<TResult>,
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;



/** Mapping between all available schema types and the resolvers types */
export type ResolversTypes = {
  Boolean: ResolverTypeWrapper<Scalars['Boolean']['output']>;
  ChatResponse: ResolverTypeWrapper<ChatResponse>;
  ControllerInstance: ResolverTypeWrapper<ControllerInstance>;
  Date: ResolverTypeWrapper<Scalars['Date']['output']>;
  Float: ResolverTypeWrapper<Scalars['Float']['output']>;
  ID: ResolverTypeWrapper<Scalars['ID']['output']>;
  InitUnsTopic: InitUnsTopic;
  InsertUnsNode: InsertUnsNode;
  InsertUser: InsertUser;
  Int: ResolverTypeWrapper<Scalars['Int']['output']>;
  Mutation: ResolverTypeWrapper<{}>;
  Query: ResolverTypeWrapper<{}>;
  QuestDbMapping: ResolverTypeWrapper<QuestDbMapping>;
  Repository: ResolverTypeWrapper<Repository>;
  RttConfigVersion: ResolverTypeWrapper<RttConfigVersion>;
  RttInstance: ResolverTypeWrapper<RttInstance>;
  RttMigrationInstance: ResolverTypeWrapper<RttMigrationInstance>;
  RttMigrationResult: ResolverTypeWrapper<RttMigrationResult>;
  RttNode: ResolverTypeWrapper<RttNode>;
  RttProcess: ResolverTypeWrapper<RttProcess>;
  RttProcessStatus: ResolverTypeWrapper<RttProcessStatus>;
  RttProxyInstanceStatus: ResolverTypeWrapper<RttProxyInstanceStatus>;
  RttVersion: ResolverTypeWrapper<RttVersion>;
  String: ResolverTypeWrapper<Scalars['String']['output']>;
  Timestamp: ResolverTypeWrapper<Scalars['Timestamp']['output']>;
  TreeStructure: ResolverTypeWrapper<TreeStructure>;
  UnsAssetSummary: ResolverTypeWrapper<UnsAssetSummary>;
  UnsAttributeSummary: ResolverTypeWrapper<UnsAttributeSummary>;
  UnsAttributeType: UnsAttributeType;
  UnsNode: ResolverTypeWrapper<UnsNode>;
  UnsNodeType: UnsNodeType;
  UpdateUnsNode: UpdateUnsNode;
  UpdateUser: UpdateUser;
  UpdateUserPassword: UpdateUserPassword;
  User: ResolverTypeWrapper<User>;
  UserRoleType: UserRoleType;
};

/** Mapping between all available schema types and the resolvers parents */
export type ResolversParentTypes = {
  Boolean: Scalars['Boolean']['output'];
  ChatResponse: ChatResponse;
  ControllerInstance: ControllerInstance;
  Date: Scalars['Date']['output'];
  Float: Scalars['Float']['output'];
  ID: Scalars['ID']['output'];
  InitUnsTopic: InitUnsTopic;
  InsertUnsNode: InsertUnsNode;
  InsertUser: InsertUser;
  Int: Scalars['Int']['output'];
  Mutation: {};
  Query: {};
  QuestDbMapping: QuestDbMapping;
  Repository: Repository;
  RttConfigVersion: RttConfigVersion;
  RttInstance: RttInstance;
  RttMigrationInstance: RttMigrationInstance;
  RttMigrationResult: RttMigrationResult;
  RttNode: RttNode;
  RttProcess: RttProcess;
  RttProcessStatus: RttProcessStatus;
  RttProxyInstanceStatus: RttProxyInstanceStatus;
  RttVersion: RttVersion;
  String: Scalars['String']['output'];
  Timestamp: Scalars['Timestamp']['output'];
  TreeStructure: TreeStructure;
  UnsAssetSummary: UnsAssetSummary;
  UnsAttributeSummary: UnsAttributeSummary;
  UnsNode: UnsNode;
  UpdateUnsNode: UpdateUnsNode;
  UpdateUser: UpdateUser;
  UpdateUserPassword: UpdateUserPassword;
  User: User;
};

export type ChatResponseResolvers<ContextType = any, ParentType extends ResolversParentTypes['ChatResponse'] = ResolversParentTypes['ChatResponse']> = {
  requestId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  threadId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type ControllerInstanceResolvers<ContextType = any, ParentType extends ResolversParentTypes['ControllerInstance'] = ResolversParentTypes['ControllerInstance']> = {
  controllerName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['Timestamp'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  isMaster?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  lastSeenAt?: Resolver<Maybe<ResolversTypes['Timestamp']>, ParentType, ContextType>;
  status?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['Timestamp'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export interface DateScalarConfig extends GraphQLScalarTypeConfig<ResolversTypes['Date'], any> {
  name: 'Date';
}

export type MutationResolvers<ContextType = any, ParentType extends ResolversParentTypes['Mutation'] = ResolversParentTypes['Mutation']> = {
  AddUnsNode?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType, Partial<MutationAddUnsNodeArgs>>;
  ChangeUserPassword?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, Partial<MutationChangeUserPasswordArgs>>;
  ChatDeleteThread?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, Partial<MutationChatDeleteThreadArgs>>;
  ChatPrompt?: Resolver<Maybe<ResolversTypes['ChatResponse']>, ParentType, ContextType, Partial<MutationChatPromptArgs>>;
  ClearRttDeployStatus?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, Partial<MutationClearRttDeployStatusArgs>>;
  CreateUser?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, Partial<MutationCreateUserArgs>>;
  DeleteRttNode?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, Partial<MutationDeleteRttNodeArgs>>;
  DeleteRttNodeInstance?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, Partial<MutationDeleteRttNodeInstanceArgs>>;
  DeleteRttNodeVersion?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, Partial<MutationDeleteRttNodeVersionArgs>>;
  DeleteUnsNode?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, Partial<MutationDeleteUnsNodeArgs>>;
  DeployRttNode?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, Partial<MutationDeployRttNodeArgs>>;
  KillRttProcess?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, Partial<MutationKillRttProcessArgs>>;
  MigrateRttNodeInstances?: Resolver<Maybe<ResolversTypes['RttMigrationResult']>, ParentType, ContextType, Partial<MutationMigrateRttNodeInstancesArgs>>;
  MintServiceAccessToken?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType, Partial<MutationMintServiceAccessTokenArgs>>;
  ModifyUnsNode?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, Partial<MutationModifyUnsNodeArgs>>;
  PurgeAssetDescriptions?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType, Partial<MutationPurgeAssetDescriptionsArgs>>;
  PurgeAttributeTags?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType, Partial<MutationPurgeAttributeTagsArgs>>;
  PurgeOldNodes?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, Partial<MutationPurgeOldNodesArgs>>;
  PurgeUnsNodes?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType, RequireFields<MutationPurgeUnsNodesArgs, 'type'>>;
  RebuildRttNodeVersion?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, Partial<MutationRebuildRttNodeVersionArgs>>;
  SaveRttConfigVersion?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType, Partial<MutationSaveRttConfigVersionArgs>>;
  SetRttNodeConfigForVersion?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, Partial<MutationSetRttNodeConfigForVersionArgs>>;
  StartRttNodeVersion?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, Partial<MutationStartRttNodeVersionArgs>>;
  StopRttNodeVersion?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, Partial<MutationStopRttNodeVersionArgs>>;
  UpdateUser?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType, Partial<MutationUpdateUserArgs>>;
};

export type QueryResolvers<ContextType = any, ParentType extends ResolversParentTypes['Query'] = ResolversParentTypes['Query']> = {
  GetAssets?: Resolver<Maybe<Array<Maybe<ResolversTypes['UnsAssetSummary']>>>, ParentType, ContextType, Partial<QueryGetAssetsArgs>>;
  GetAttributes?: Resolver<Maybe<Array<Maybe<ResolversTypes['UnsAttributeSummary']>>>, ParentType, ContextType, Partial<QueryGetAttributesArgs>>;
  GetControllerInstances?: Resolver<Maybe<Array<Maybe<ResolversTypes['ControllerInstance']>>>, ParentType, ContextType>;
  GetRepositories?: Resolver<Maybe<Array<Maybe<ResolversTypes['Repository']>>>, ParentType, ContextType>;
  GetRepository?: Resolver<Maybe<ResolversTypes['Repository']>, ParentType, ContextType, Partial<QueryGetRepositoryArgs>>;
  GetRttConfigSchema?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType, Partial<QueryGetRttConfigSchemaArgs>>;
  GetRttConfigTemplate?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType, Partial<QueryGetRttConfigTemplateArgs>>;
  GetRttConfigTemplates?: Resolver<Maybe<Array<Maybe<ResolversTypes['String']>>>, ParentType, ContextType, Partial<QueryGetRttConfigTemplatesArgs>>;
  GetRttConfigVersion?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType, Partial<QueryGetRttConfigVersionArgs>>;
  GetRttNodeConfig?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType, Partial<QueryGetRttNodeConfigArgs>>;
  GetRttNodes?: Resolver<Maybe<Array<Maybe<ResolversTypes['RttNode']>>>, ParentType, ContextType, Partial<QueryGetRttNodesArgs>>;
  GetRttProcessStatus?: Resolver<Maybe<ResolversTypes['RttProcessStatus']>, ParentType, ContextType, Partial<QueryGetRttProcessStatusArgs>>;
  GetTags?: Resolver<Maybe<Array<Maybe<ResolversTypes['String']>>>, ParentType, ContextType>;
  GetTreeStructure?: Resolver<Maybe<Array<Maybe<ResolversTypes['TreeStructure']>>>, ParentType, ContextType, Partial<QueryGetTreeStructureArgs>>;
  GetUnsNodes?: Resolver<Maybe<Array<Maybe<ResolversTypes['UnsNode']>>>, ParentType, ContextType>;
  GetUsers?: Resolver<Maybe<Array<Maybe<ResolversTypes['User']>>>, ParentType, ContextType>;
  ListRttConfigVersions?: Resolver<Maybe<Array<Maybe<ResolversTypes['RttConfigVersion']>>>, ParentType, ContextType, Partial<QueryListRttConfigVersionsArgs>>;
  ListRttProcesses?: Resolver<Maybe<Array<Maybe<ResolversTypes['RttProcess']>>>, ParentType, ContextType, Partial<QueryListRttProcessesArgs>>;
  QuestDBMappings?: Resolver<Maybe<Array<Maybe<ResolversTypes['QuestDbMapping']>>>, ParentType, ContextType>;
};

export type QuestDbMappingResolvers<ContextType = any, ParentType extends ResolversParentTypes['QuestDbMapping'] = ResolversParentTypes['QuestDbMapping']> = {
  dataGroup?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  packageName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  processName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  questdbUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  suffix?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  tableName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  tablePrefix?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  topicPrefix?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  updatedAt?: Resolver<Maybe<ResolversTypes['Timestamp']>, ParentType, ContextType>;
  version?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type RepositoryResolvers<ContextType = any, ParentType extends ResolversParentTypes['Repository'] = ResolversParentTypes['Repository']> = {
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  tags?: Resolver<Maybe<Array<Maybe<ResolversTypes['String']>>>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type RttConfigVersionResolvers<ContextType = any, ParentType extends ResolversParentTypes['RttConfigVersion'] = ResolversParentTypes['RttConfigVersion']> = {
  appTag?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  createdAt?: Resolver<Maybe<ResolversTypes['Timestamp']>, ParentType, ContextType>;
  createdBy?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  label?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schemaHash?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type RttInstanceResolvers<ContextType = any, ParentType extends ResolversParentTypes['RttInstance'] = ResolversParentTypes['RttInstance']> = {
  configAvailable?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  handoverEnabled?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  handoverState?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  handoverUpdatedAt?: Resolver<Maybe<ResolversTypes['Timestamp']>, ParentType, ContextType>;
  id?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  instanceMode?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  processName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  processes?: Resolver<Maybe<Array<Maybe<ResolversTypes['RttProcess']>>>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type RttMigrationInstanceResolvers<ContextType = any, ParentType extends ResolversParentTypes['RttMigrationInstance'] = ResolversParentTypes['RttMigrationInstance']> = {
  instanceId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  processName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  reason?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  status?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  version?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type RttMigrationResultResolvers<ContextType = any, ParentType extends ResolversParentTypes['RttMigrationResult'] = ResolversParentTypes['RttMigrationResult']> = {
  instances?: Resolver<Maybe<Array<Maybe<ResolversTypes['RttMigrationInstance']>>>, ParentType, ContextType>;
  message?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  ok?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type RttNodeResolvers<ContextType = any, ParentType extends ResolversParentTypes['RttNode'] = ResolversParentTypes['RttNode']> = {
  author?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  deployMessage?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  deployStatus?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  deployTag?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  deployedVersions?: Resolver<Maybe<Array<Maybe<ResolversTypes['String']>>>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  lastErrLog?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  lastLog?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  latestDeployedVersion?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  memory?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  pid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  processes?: Resolver<Maybe<Array<Maybe<ResolversTypes['RttProcess']>>>, ParentType, ContextType>;
  restarts?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  rttNode?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  runningVersion?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  status?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  topics?: Resolver<Maybe<Array<Maybe<ResolversTypes['String']>>>, ParentType, ContextType>;
  uptime?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  version?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  versions?: Resolver<Maybe<Array<Maybe<ResolversTypes['RttVersion']>>>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type RttProcessResolvers<ContextType = any, ParentType extends ResolversParentTypes['RttProcess'] = ResolversParentTypes['RttProcess']> = {
  instanceId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  memory?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  pid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  pmId?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  restarts?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  status?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  uptime?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  version?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type RttProcessStatusResolvers<ContextType = any, ParentType extends ResolversParentTypes['RttProcessStatus'] = ResolversParentTypes['RttProcessStatus']> = {
  active?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  handoverState?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  handoverUpdatedAt?: Resolver<Maybe<ResolversTypes['Timestamp']>, ParentType, ContextType>;
  heapTotal?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  heapUsed?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  instances?: Resolver<Maybe<Array<Maybe<ResolversTypes['RttProxyInstanceStatus']>>>, ParentType, ContextType>;
  packageName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  processName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  processVersion?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type RttProxyInstanceStatusResolvers<ContextType = any, ParentType extends ResolversParentTypes['RttProxyInstanceStatus'] = ResolversParentTypes['RttProxyInstanceStatus']> = {
  alive?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  apiEndpointsCount?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  lastUpdatedAt?: Resolver<Maybe<ResolversTypes['Timestamp']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  publishedMessageBytes?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  publishedMessageCount?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  publisherActive?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  subscribedMessageBytes?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  subscribedMessageCount?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  subscriberActive?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  topicsCount?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  uptimeMinutes?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type RttVersionResolvers<ContextType = any, ParentType extends ResolversParentTypes['RttVersion'] = ResolversParentTypes['RttVersion']> = {
  instances?: Resolver<Maybe<Array<Maybe<ResolversTypes['RttInstance']>>>, ParentType, ContextType>;
  isInstalled?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  version?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export interface TimestampScalarConfig extends GraphQLScalarTypeConfig<ResolversTypes['Timestamp'], any> {
  name: 'Timestamp';
}

export type TreeStructureResolvers<ContextType = any, ParentType extends ResolversParentTypes['TreeStructure'] = ResolversParentTypes['TreeStructure']> = {
  apiCatchallBase?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  apiCatchallBasePath?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  apiCatchallSwaggerPath?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  apiCatchallSwaggerUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  apiDescription?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  apiEndpoint?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  apiHost?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  apiMethod?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  apiProxyHost?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  apiSwaggerEndpoint?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  asset?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  attributeNeedsPersistance?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  attributeTags?: Resolver<Maybe<Array<Maybe<ResolversTypes['String']>>>, ParentType, ContextType>;
  attributeTimestamp?: Resolver<Maybe<ResolversTypes['Timestamp']>, ParentType, ContextType>;
  attributeType?: Resolver<Maybe<ResolversTypes['UnsAttributeType']>, ParentType, ContextType>;
  children?: Resolver<Maybe<Array<Maybe<ResolversTypes['TreeStructure']>>>, ParentType, ContextType>;
  dataGroup?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  fullTopic?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  objectId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  objectType?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  parent?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  processName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  processVersion?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  questdbTableNames?: Resolver<Maybe<Array<Maybe<ResolversTypes['String']>>>, ParentType, ContextType>;
  questdbTablePrefix?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  questdbUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  type?: Resolver<Maybe<ResolversTypes['UnsNodeType']>, ParentType, ContextType>;
  unsNode?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type UnsAssetSummaryResolvers<ContextType = any, ParentType extends ResolversParentTypes['UnsAssetSummary'] = ResolversParentTypes['UnsAssetSummary']> = {
  asset?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  objectId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  objectType?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  path?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type UnsAttributeSummaryResolvers<ContextType = any, ParentType extends ResolversParentTypes['UnsAttributeSummary'] = ResolversParentTypes['UnsAttributeSummary']> = {
  attributeType?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  dataGroup?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  objectId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  objectType?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  path?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type UnsNodeResolvers<ContextType = any, ParentType extends ResolversParentTypes['UnsNode'] = ResolversParentTypes['UnsNode']> = {
  apiDescription?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  apiEndpoint?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  apiHost?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  apiMethod?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  apiProxyHost?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  apiSwaggerEndpoint?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  asset?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  attributeNeedsPersistance?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  attributeTags?: Resolver<Maybe<Array<Maybe<ResolversTypes['String']>>>, ParentType, ContextType>;
  attributeTimestamp?: Resolver<Maybe<ResolversTypes['Timestamp']>, ParentType, ContextType>;
  attributeType?: Resolver<Maybe<ResolversTypes['UnsAttributeType']>, ParentType, ContextType>;
  dataGroup?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  fullTopic?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  objectId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  objectType?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  parent?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  processName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  processVersion?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  type?: Resolver<Maybe<ResolversTypes['UnsNodeType']>, ParentType, ContextType>;
  unsNode?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type UserResolvers<ContextType = any, ParentType extends ResolversParentTypes['User'] = ResolversParentTypes['User']> = {
  accessRules?: Resolver<Maybe<Array<Maybe<ResolversTypes['String']>>>, ParentType, ContextType>;
  email?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  roles?: Resolver<Maybe<Array<Maybe<ResolversTypes['UserRoleType']>>>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type Resolvers<ContextType = any> = {
  ChatResponse?: ChatResponseResolvers<ContextType>;
  ControllerInstance?: ControllerInstanceResolvers<ContextType>;
  Date?: GraphQLScalarType;
  Mutation?: MutationResolvers<ContextType>;
  Query?: QueryResolvers<ContextType>;
  QuestDbMapping?: QuestDbMappingResolvers<ContextType>;
  Repository?: RepositoryResolvers<ContextType>;
  RttConfigVersion?: RttConfigVersionResolvers<ContextType>;
  RttInstance?: RttInstanceResolvers<ContextType>;
  RttMigrationInstance?: RttMigrationInstanceResolvers<ContextType>;
  RttMigrationResult?: RttMigrationResultResolvers<ContextType>;
  RttNode?: RttNodeResolvers<ContextType>;
  RttProcess?: RttProcessResolvers<ContextType>;
  RttProcessStatus?: RttProcessStatusResolvers<ContextType>;
  RttProxyInstanceStatus?: RttProxyInstanceStatusResolvers<ContextType>;
  RttVersion?: RttVersionResolvers<ContextType>;
  Timestamp?: GraphQLScalarType;
  TreeStructure?: TreeStructureResolvers<ContextType>;
  UnsAssetSummary?: UnsAssetSummaryResolvers<ContextType>;
  UnsAttributeSummary?: UnsAttributeSummaryResolvers<ContextType>;
  UnsNode?: UnsNodeResolvers<ContextType>;
  User?: UserResolvers<ContextType>;
};
