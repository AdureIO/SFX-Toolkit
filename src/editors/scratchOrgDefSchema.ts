/**
 * Schema definitions for Salesforce Scratch Org Definition files
 * Feature list extracted from official Salesforce documentation
 */

export interface ScratchOrgDefinition {
    orgName?: string;
    edition?: OrgEdition;
    country?: string;
    username?: string;
    adminEmail?: string;
    description?: string;
    language?: string;
    hasSampleData?: boolean;
    features?: string[];
    settings?: OrgSettings;
    orgPreferences?: OrgPreferences;
    snapshot?: string;
    release?: 'Preview' | 'Previous';
}

export type OrgEdition = 'Developer' | 'Enterprise' | 'Group' | 'Professional' | 'Partner Developer' | 'Partner Enterprise' | 'Partner Group' | 'Partner Professional';

export interface OrgSettings {
    [category: string]: {
        [setting: string]: any;
    };
}

export interface OrgPreferences {
    enabled?: string[];
    disabled?: string[];
}

// Complete list of Salesforce Features from official documentation
export const ALL_FEATURES = [
    { name: 'AccountInspection', description: 'Account Intelligence view', hasParams: false },
    { name: 'AccountingSubledgerGrowthEdition', description: 'Accounting Subledger Growth features', hasParams: false },
    { name: 'AccountingSubledgerStarterEdition', description: 'Accounting Subledger Starter features', hasParams: false },
    { name: 'AccountingSubledgerUser', description: 'Accounting Subledger Growth access', hasParams: false },
    { name: 'AddCustomApps', description: 'Increase custom apps (1-30)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 30 },
    { name: 'AddCustomObjects', description: 'Increase custom objects (1-30)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 30 },
    { name: 'AddCustomRelationships', description: 'Increase custom relationships (1-10)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 10 },
    { name: 'AddCustomTabs', description: 'Increase custom tabs (1-30)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 30 },
    { name: 'AddDataComCRMRecordCredit', description: 'Increase Data.com record import credits (1-30)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 30 },
    { name: 'AddInsightsQueryLimit', description: 'Increase CRM Analytics query size (1-30)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 30 },
    { name: 'AdditionalFieldHistory', description: 'Track more field history (1-40)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 40 },
    { name: 'AdmissionsConnectUser', description: 'Enable Admissions Connect components', hasParams: false },
    { name: 'AdvisorLinkFeature', description: 'Enable Student Success Hub components', hasParams: false },
    { name: 'AdvisorLinkPathwaysFeature', description: 'Enable Pathways components', hasParams: false },
    { name: 'AIAttribution', description: 'Einstein Attribution for Marketing Cloud', hasParams: false },
    { name: 'AllUserIdServiceAccess', description: 'All users access user ID service', hasParams: false },
    { name: 'AnalyticsAdminPerms', description: 'CRM Analytics admin permissions', hasParams: false },
    { name: 'AnalyticsAppEmbedded', description: 'CRM Analytics Embedded App license', hasParams: false },
    { name: 'ApexGuruCodeAnalyzer', description: 'ApexGuru AI-powered code insights', hasParams: false },
    { name: 'API', description: 'Additional APIs (SOAP, Streaming, Bulk)', hasParams: false },
    { name: 'ArcGraphCommunity', description: 'ARC components for Experience Cloud', hasParams: false },
    { name: 'Assessments', description: 'Dynamic Assessments features', hasParams: false },
    { name: 'AssetScheduling', description: 'Asset Scheduling license (1-10)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 10 },
    { name: 'AssociationEngine', description: 'Association Engine for branch units', hasParams: false },
    { name: 'AuthorApex', description: 'Access and modify Apex code', hasParams: false },
    { name: 'B2BCommerce', description: 'B2B Commerce license', hasParams: false },
    { name: 'B2BLoyaltyManagement', description: 'B2B Loyalty Management', hasParams: false },
    { name: 'B2CCommerceGMV', description: 'B2B2C Commerce license', hasParams: false },
    { name: 'B2CLoyaltyManagement', description: 'Loyalty Management - Growth', hasParams: false },
    { name: 'B2CLoyaltyManagementPlus', description: 'Loyalty Management - Advanced', hasParams: false },
    { name: 'BatchManagement', description: 'Batch Management license', hasParams: false },
    { name: 'BenefitManagement', description: 'Benefit management (Public Sector)', hasParams: false },
    { name: 'BigObjectsBulkAPI', description: 'BigObjects in Bulk API', hasParams: false },
    { name: 'BillingAdvanced', description: 'Revenue Cloud Billing (Advanced)', hasParams: false },
    { name: 'Briefcase', description: 'Briefcase Builder for offline', hasParams: false },
    { name: 'BudgetManagement', description: 'Budget management features', hasParams: false },
    { name: 'BusinessRulesEngine', description: 'Expression sets and lookup tables', hasParams: false },
    { name: 'BYOCCaaS', description: 'Bring Your Own CCaaS', hasParams: false },
    { name: 'BYOOTT', description: 'Bring Your Own Messaging channel', hasParams: false },
    { name: 'CacheOnlyKeys', description: 'Cache-only keys service', hasParams: false },
    { name: 'CalloutSizeMB', description: 'Max Apex callout size (3-12 MB)', hasParams: true, paramType: 'number', paramMin: 3, paramMax: 12 },
    { name: 'CampaignInfluence2', description: 'Customizable Campaign Influence', hasParams: false },
    { name: 'CascadeDelete', description: 'Cascade delete for lookups', hasParams: false },
    { name: 'CaseClassification', description: 'Einstein Case Classification', hasParams: false },
    { name: 'CaseWrapUp', description: 'Einstein Case Wrap-Up', hasParams: false },
    { name: 'CGAnalytics', description: 'Consumer Goods Analytics', hasParams: false },
    { name: 'ChangeDataCapture', description: 'Change Data Capture', hasParams: false },
    { name: 'Chatbot', description: 'Bot metadata deployment', hasParams: false },
    { name: 'ChatterEmailFooterLogo', description: 'Custom Chatter email logo', hasParams: false },
    { name: 'ChatterEmailFooterText', description: 'Custom Chatter email footer', hasParams: false },
    { name: 'ChatterEmailSenderName', description: 'Custom Chatter sender name', hasParams: false },
    { name: 'CloneApplication', description: 'Clone Lightning apps', hasParams: false },
    { name: 'CMSMaxContType', description: 'Limit CMS content types (21)', hasParams: false },
    { name: 'CMSMaxNodesPerContType', description: 'Limit CMS child nodes (15)', hasParams: false },
    { name: 'CMSUnlimitedUse', description: 'Unlimited Salesforce CMS', hasParams: false },
    { name: 'Communities', description: 'Experience Cloud sites', hasParams: false },
    { name: 'CompareReportsOrgPerm', description: 'Compare Lightning Reports', hasParams: false },
    { name: 'ConAppPluginExecuteAsUser', description: 'ConnectedApp pluginExecutionUser', hasParams: false },
    { name: 'ConcStreamingClients', description: 'Concurrent streaming clients (20-4000)', hasParams: true, paramType: 'number', paramMin: 20, paramMax: 4000 },
    { name: 'ConnectedAppCustomNotifSubscription', description: 'Custom notifications subscription', hasParams: false },
    { name: 'ConnectedAppToolingAPI', description: 'Connected apps with Tooling API', hasParams: false },
    { name: 'ConsentEventStream', description: 'Consent Event Stream permission', hasParams: false },
    { name: 'ConsolePersistenceInterval', description: 'Console save interval (0-500 min)', hasParams: true, paramType: 'number', paramMin: 0, paramMax: 500 },
    { name: 'ContactsToMultipleAccounts', description: 'Relate contacts to multiple accounts', hasParams: false },
    { name: 'ContractApprovals', description: 'Contract approval process', hasParams: false },
    { name: 'ContractManagement', description: 'Contract Lifecycle Management', hasParams: false },
    { name: 'ContractMgmtInd', description: 'CLM for Industries', hasParams: false },
    { name: 'CoreCpq', description: 'Revenue Cloud features', hasParams: false },
    { name: 'CPQ', description: 'Salesforce CPQ license', hasParams: false },
    { name: 'CustomerDataPlatform', description: 'Data Cloud license', hasParams: false },
    { name: 'CustomerDataPlatformLite', description: 'Data Cloud Lite', hasParams: false },
    { name: 'CustomerExperienceAnalytics', description: 'Customer Lifecycle Analytics', hasParams: false },
    { name: 'CustomFieldDataTranslation', description: 'Translate custom field data', hasParams: false },
    { name: 'CustomNotificationType', description: 'Custom notification types', hasParams: false },
    { name: 'DataComDnbAccounts', description: 'Data.com account features', hasParams: false },
    { name: 'DataComFullClean', description: 'Data.com cleaning features', hasParams: false },
    { name: 'DataMaskUser', description: 'Data Mask permission sets (30)', hasParams: false },
    { name: 'DataProcessingEngine', description: 'Data Processing Engine license', hasParams: false },
    { name: 'DebugApex', description: 'Apex Interactive Debugger', hasParams: false },
    { name: 'DecisionTable', description: 'Decision Table license', hasParams: false },
    { name: 'DefaultWorkflowUser', description: 'Admin as default workflow user', hasParams: false },
    { name: 'DeferSharingCalc', description: 'Suspend sharing calculations', hasParams: false },
    { name: 'DevelopmentWave', description: 'CRM Analytics development', hasParams: false },
    { name: 'DeviceTrackingEnabled', description: 'Device Tracking', hasParams: false },
    { name: 'DevOpsCenter', description: 'DevOps Center', hasParams: false },
    { name: 'DisableManageIdConfAPI', description: 'Limit LoginIP/ClientBrowser API', hasParams: false },
    { name: 'DisclosureFramework', description: 'Disclosure and Compliance Hub', hasParams: false },
    { name: 'Division', description: 'Manage Divisions feature', hasParams: false },
    { name: 'DocGen', description: 'Document Generation', hasParams: false },
    { name: 'DocGenDesigner', description: 'Document template designer', hasParams: false },
    { name: 'DocGenInd', description: 'Industry Document Generation', hasParams: false },
    { name: 'DocumentChecklist', description: 'Document Tracking and Approval', hasParams: false },
    { name: 'DocumentReaderPageLimit', description: 'Limit extraction pages (5)', hasParams: false },
    { name: 'DSARPortability', description: 'DSAR Portability in Privacy Center', hasParams: false },
    { name: 'DurableClassicStreamingAPI', description: 'Durable PushTopic Streaming', hasParams: false },
    { name: 'DurableGenericStreamingAPI', description: 'Durable Generic Streaming', hasParams: false },
    { name: 'DynamicClientCreationLimit', description: 'OAuth dynamic registration (100)', hasParams: false },
    { name: 'EAndUDigitalSales', description: 'Energy & Utilities Digital Sales', hasParams: false },
    { name: 'EAndUSelfServicePortal', description: 'E&U Self Service Portal', hasParams: false },
    { name: 'EAOutputConnectors', description: 'CRM Analytics Output Connectors', hasParams: false },
    { name: 'EASyncOut', description: 'CRM Analytics SyncOut', hasParams: false },
    { name: 'EdPredictionM3Threshold', description: 'Einstein Discovery M3 threshold', hasParams: false },
    { name: 'EdPredictionTimeout', description: 'Einstein Discovery timeout (100ms)', hasParams: false },
    { name: 'EdPredictionTimeoutBulk', description: 'Einstein Discovery bulk timeout', hasParams: false },
    { name: 'EdPredictionTimeoutByomBulk', description: 'BYOM prediction timeout', hasParams: false },
    { name: 'EducationCloud', description: 'Education Cloud', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 10 },
    { name: 'Einstein1AIPlatform', description: 'Einstein generative AI (Agentforce)', hasParams: false },
    { name: 'EinsteinAnalyticsPlus', description: 'CRM Analytics Plus license', hasParams: false },
    { name: 'EinsteinArticleRecommendations', description: 'Einstein Article Recommendations', hasParams: false },
    { name: 'EinsteinBuilderFree', description: 'Einstein Prediction Builder (1 free)', hasParams: false },
    { name: 'EinsteinDocReader', description: 'Intelligent Form Reader', hasParams: false },
    { name: 'EinsteinRecommendationBuilder', description: 'Einstein Recommendation Builder', hasParams: false },
    { name: 'EinsteinSearch', description: 'Einstein Search features', hasParams: false },
    { name: 'EinsteinVisits', description: 'Consumer Goods Cloud', hasParams: false },
    { name: 'EinsteinVisitsED', description: 'Einstein Visits with Discovery', hasParams: false },
    { name: 'EmbeddedLoginForIE', description: 'Embedded Login IE11 support', hasParams: false },
    { name: 'EmpPublishRateLimit', description: 'Platform event publish rate (1000-10000)', hasParams: true, paramType: 'number', paramMin: 1000, paramMax: 10000 },
    { name: 'EnablePRM', description: 'Partner relationship management', hasParams: false },
    { name: 'EnableManageIdConfUI', description: 'LoginIP/ClientBrowser UI access', hasParams: false },
    { name: 'Enablement', description: 'Sales programs with Enablement', hasParams: false },
    { name: 'EnableSetPasswordInApi', description: 'Reset password without old one', hasParams: false },
    { name: 'EncryptionStatisticsInterval', description: 'Encryption stats interval (sec)', hasParams: true, paramType: 'number', paramMin: 0, paramMax: 604800 },
    { name: 'EncryptionSyncInterval', description: 'Encryption sync interval (sec)', hasParams: true, paramType: 'number', paramMin: 0, paramMax: 604800 },
    { name: 'EnergyAndUtilitiesCloud', description: 'Energy and Utilities Cloud', hasParams: false },
    { name: 'Entitlements', description: 'Entitlements for support', hasParams: false },
    { name: 'ERMAnalytics', description: 'ERM Analytics', hasParams: false },
    { name: 'EventLogFile', description: 'Event log file API access', hasParams: false },
    { name: 'EntityTranslation', description: 'Field data translation', hasParams: false },
    { name: 'ExcludeSAMLSessionIndex', description: 'Exclude SAML session index', hasParams: false },
    { name: 'Explainability', description: 'Decision Explainer features', hasParams: false },
    { name: 'ExpressionSetMaxExecPerHour', description: 'Expression sets max (500k/hour)', hasParams: false },
    { name: 'ExternalIdentityLogin', description: 'Customer Identity features', hasParams: false },
    { name: 'FieldAuditTrail', description: 'Field Audit Trail (60 fields)', hasParams: false },
    { name: 'FieldService', description: 'Field Service license (1-25)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 25 },
    { name: 'FieldServiceAppointmentAssistantUser', description: 'Appointment Assistant PSL (1-25)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 25 },
    { name: 'FieldServiceDispatcherUser', description: 'Dispatcher PSL (1-25)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 25 },
    { name: 'FieldServiceLastMileUser', description: 'Last Mile PSL (1-25)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 25 },
    { name: 'FieldServiceMobileExtension', description: 'Mobile Extension PSL', hasParams: false },
    { name: 'FieldServiceMobileUser', description: 'Mobile PSL (1-25)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 25 },
    { name: 'FieldServiceSchedulingUser', description: 'Scheduling PSL (1-25)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 25 },
    { name: 'FinanceLogging', description: 'Finance Logging objects', hasParams: false },
    { name: 'FinancialServicesCommunityUser', description: 'FSC Insurance Community (1-10)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 10 },
    { name: 'FinancialServicesInsuranceUser', description: 'FSC Insurance PSL', hasParams: false },
    { name: 'FinancialServicesUser', description: 'FSC Standard PSL (1-10)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 10 },
    { name: 'FlowSites', description: 'Flows in Sites and portals', hasParams: false },
    { name: 'ForceComPlatform', description: 'Salesforce Platform license', hasParams: false },
    { name: 'ForecastEnableCustomField', description: 'Custom fields in forecasts', hasParams: false },
    { name: 'FSCAlertFramework', description: 'FSC Record Alert entities', hasParams: false },
    { name: 'FSCServiceProcess', description: 'Service Process Studio', hasParams: false },
    { name: 'Fundraising', description: 'Nonprofit Cloud Fundraising', hasParams: false },
    { name: 'GenericStreaming', description: 'Generic Streaming API v36', hasParams: false },
    { name: 'GenStreamingEventsPerDay', description: 'Generic streaming events (10k-50k)', hasParams: true, paramType: 'number', paramMin: 10000, paramMax: 50000 },
    { name: 'Grantmaking', description: 'Grantmaking features', hasParams: false },
    { name: 'GuidanceHubAllowed', description: 'Guidance Center panel', hasParams: false },
    { name: 'HealthCloudAddOn', description: 'Health Cloud', hasParams: false },
    { name: 'HealthCloudEOLOverride', description: 'CandidatePatient override', hasParams: false },
    { name: 'HealthCloudForCmty', description: 'Health Cloud for Communities', hasParams: false },
    { name: 'HealthCloudMedicationReconciliation', description: 'Medication Reconciliation', hasParams: false },
    { name: 'HealthCloudPNMAddOn', description: 'Provider Network Management', hasParams: false },
    { name: 'HealthCloudUser', description: 'Health Cloud PSL', hasParams: false },
    { name: 'HighVelocitySales', description: 'Sales Engagement', hasParams: false },
    { name: 'HighVolumePlatformEventAddOn', description: 'High-volume platform events (+100k)', hasParams: false },
    { name: 'HLSAnalytics', description: 'HLS Analytics', hasParams: false },
    { name: 'HoursBetweenCoverageJob', description: 'Sharing coverage report (1-24 hours)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 24 },
    { name: 'IdentityProvisioningFeatures', description: 'Identity User Provisioning', hasParams: false },
    { name: 'IgnoreQueryParamWhitelist', description: 'Ignore query param whitelist', hasParams: false },
    { name: 'IndustriesActionPlan', description: 'Action Plans license', hasParams: false },
    { name: 'IndustriesBranchManagement', description: 'Branch Management', hasParams: false },
    { name: 'IndustriesCompliantDataSharing', description: 'Compliant Data Sharing', hasParams: false },
    { name: 'IndustriesMfgAdvncdAccFrcs', description: 'Advanced Account Forecasting', hasParams: false },
    { name: 'IndustriesMfgPartnerVisitMgmt', description: 'Partner Visit Management', hasParams: false },
    { name: 'IndustriesMfgProgram', description: 'Program Based Business', hasParams: false },
    { name: 'IndustriesMfgRebates', description: 'Rebate Management', hasParams: false },
    { name: 'IndustriesMfgTargets', description: 'Sales Agreements', hasParams: false },
    { name: 'IndustriesManufacturingCmty', description: 'Manufacturing community template', hasParams: false },
    { name: 'IndustriesMfgAccountForecast', description: 'Account Forecast', hasParams: false },
    { name: 'InsightsPlatform', description: 'CRM Analytics Plus', hasParams: false },
    { name: 'InsuranceCalculationUser', description: 'Insurance calculation', hasParams: false },
    { name: 'InsuranceClaimMgmt', description: 'Insurance claim management', hasParams: false },
    { name: 'InsurancePolicyAdmin', description: 'Insurance policy administration', hasParams: false },
    { name: 'IntelligentDocumentReader', description: 'Intelligent Document Reader', hasParams: false },
    { name: 'InvestigativeCaseManagement', description: 'Investigative case management', hasParams: false },
    { name: 'InvoiceManagement', description: 'Revenue Cloud Advanced', hasParams: false },
    { name: 'Interaction', description: 'Flows (screen & autolaunched)', hasParams: false },
    { name: 'IoT', description: 'IoT platform events', hasParams: false },
    { name: 'JigsawUser', description: 'Jigsaw license', hasParams: false },
    { name: 'Knowledge', description: 'Salesforce Knowledge', hasParams: false },
    { name: 'LegacyLiveAgentRouting', description: 'Legacy Live Agent routing', hasParams: false },
    { name: 'LightningSalesConsole', description: 'Lightning Sales Console', hasParams: false },
    { name: 'LightningScheduler', description: 'Lightning Scheduler', hasParams: false },
    { name: 'LightningServiceConsole', description: 'Lightning Service Console', hasParams: false },
    { name: 'LiveAgent', description: 'Chat for Service Cloud', hasParams: false },
    { name: 'LiveMessage', description: 'Messaging for Service Cloud', hasParams: false },
    { name: 'LongLayoutSectionTitles', description: 'Page layout titles (80 chars)', hasParams: false },
    { name: 'LoyaltyAnalytics', description: 'Analytics for Loyalty', hasParams: false },
    { name: 'LoyaltyEngine', description: 'Loyalty Promotion Setup', hasParams: false },
    { name: 'LoyaltyManagementStarter', description: 'Loyalty Management - Starter', hasParams: false },
    { name: 'LoyaltyMaximumPartners', description: 'Max loyalty partners (0-1)', hasParams: true, paramType: 'number', paramMin: 0, paramMax: 1 },
    { name: 'LoyaltyMaximumPrograms', description: 'Max loyalty programs (0-1)', hasParams: true, paramType: 'number', paramMin: 0, paramMax: 1 },
    { name: 'LoyaltyMaxOrderLinePerHour', description: 'Max order lines/hour (1-3.5M)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 3500000 },
    { name: 'LoyaltyMaxProcExecPerHour', description: 'Max TJ processed/hour (1-500k)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 500000 },
    { name: 'LoyaltyMaxTransactions', description: 'Max TJ records (1-50M)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 50000000 },
    { name: 'LoyaltyMaxTrxnJournals', description: 'Max TJ stored (1-25M)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 25000000 },
    { name: 'Macros', description: 'Macros in console', hasParams: false },
    { name: 'MarketingCloud', description: 'Marketing Cloud Growth', hasParams: false },
    { name: 'MarketingUser', description: 'Campaigns object access', hasParams: false },
    { name: 'MaterialityAssessment', description: 'Materiality assessment (Net Zero)', hasParams: false },
    { name: 'MaxActiveDPEDefs', description: 'Active DPE definitions (1-50)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 50 },
    { name: 'MaxApexCodeSize', description: 'Max Apex code size (MB)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 100 },
    { name: 'MaxAudTypeCriterionPerAud', description: 'Audience type criteria (10)', hasParams: false },
    { name: 'MaxCustomLabels', description: 'Custom labels in thousands (1-15)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 15 },
    { name: 'MaxDatasetLinksPerDT', description: 'Dataset links per DT (1-3)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 3 },
    { name: 'MaxDataSourcesPerDPE', description: 'Source nodes per DPE (1-50)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 50 },
    { name: 'MaxDecisionTableAllowed', description: 'Decision tables (1-30)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 30 },
    { name: 'MaxFavoritesAllowed', description: 'User favorites (0-200)', hasParams: true, paramType: 'number', paramMin: 0, paramMax: 200 },
    { name: 'MaxFieldsPerNode', description: 'Fields per DPE node (1-500)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 500 },
    { name: 'MaxInputColumnsPerDT', description: 'Input fields per DT (1-10)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 10 },
    { name: 'MaxLoyaltyProcessRules', description: 'Loyalty process rules (1-20)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 20 },
    { name: 'MaxNodesPerDPE', description: 'Nodes per DPE (1-500)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 500 },
    { name: 'MaxNoOfLexThemesAllowed', description: 'Lightning themes (0-300)', hasParams: true, paramType: 'number', paramMin: 0, paramMax: 300 },
    { name: 'MaxOutputColumnsPerDT', description: 'Output fields per DT (1-5)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 5 },
    { name: 'MaxSourceObjectPerDSL', description: 'Source objects per dataset link (1-5)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 5 },
    { name: 'MaxStreamingTopics', description: 'PushTopic events/day (40-100)', hasParams: true, paramType: 'number', paramMin: 40, paramMax: 100 },
    { name: 'MaxUserNavItemsAllowed', description: 'Nav bar items (0-500)', hasParams: true, paramType: 'number', paramMin: 0, paramMax: 500 },
    { name: 'MaxUserStreamingChannels', description: 'User streaming channels (20-1000)', hasParams: true, paramType: 'number', paramMin: 20, paramMax: 1000 },
    { name: 'MaxWishlistsItemsPerWishlist', description: 'Wishlist items (500)', hasParams: false },
    { name: 'MaxWishlistsPerStoreAccUsr', description: 'Wishlists per store/account/user (100)', hasParams: false },
    { name: 'MaxWritebacksPerDPE', description: 'Writeback nodes per DPE (1-50)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 50 },
    { name: 'MedVisDescriptorLimit', description: 'Sharing definitions (150-1600)', hasParams: true, paramType: 'number', paramMin: 150, paramMax: 1600 },
    { name: 'MinKeyRotationInterval', description: 'Encryption key rotation (60s)', hasParams: false },
    { name: 'MobileExtMaxFileSizeMB', description: 'FS Mobile ext file size (1-2000 MB)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 2000 },
    { name: 'MobileSecurity', description: 'Enhanced Mobile Security', hasParams: false },
    { name: 'MobileVoiceAndLLM', description: 'Offline LLM/voice models', hasParams: false },
    { name: 'MultiCurrency', description: 'Enable multiple currencies', hasParams: false },
    { name: 'MultiLevelMasterDetail', description: 'Multi-level master-detail', hasParams: false },
    { name: 'MutualAuthentication', description: 'Client certificate verification', hasParams: false },
    { name: 'MyTrailhead', description: 'myTrailhead enablement site', hasParams: false },
    { name: 'NonprofitCloudCaseManagementUser', description: 'Nonprofit Cloud Case Management', hasParams: false },
    { name: 'NumPlatformEvents', description: 'Platform event definitions (5-20)', hasParams: true, paramType: 'number', paramMin: 5, paramMax: 20 },
    { name: 'ObjectLinking', description: 'Auto-link channel interactions (Beta)', hasParams: false },
    { name: 'OmnistudioMetadata', description: 'OmniStudio metadata API', hasParams: false },
    { name: 'OmnistudioRuntime', description: 'Execute OmniScripts/FlexCards', hasParams: false },
    { name: 'OmnistudioDesigner', description: 'Create OmniScripts/DataMappers', hasParams: false },
    { name: 'OrderManagement', description: 'Salesforce Order Management', hasParams: false },
    { name: 'OrderSaveLogicEnabled', description: 'New Order Save Behavior only', hasParams: false },
    { name: 'OrderSaveBehaviorBoth', description: 'Both order save behaviors', hasParams: false },
    { name: 'OutboundMessageHTTPSession', description: 'HTTP endpoints with session ID', hasParams: false },
    { name: 'OutcomeManagement', description: 'Outcome Management', hasParams: false },
    { name: 'PardotScFeaturesCampaignInfluence', description: 'Campaign influence for Pardot', hasParams: false },
    { name: 'PersonAccounts', description: 'Person accounts', hasParams: false },
    { name: 'PipelineInspection', description: 'Pipeline Inspection view', hasParams: false },
    { name: 'PlatformCache', description: 'Platform Cache (3 MB)', hasParams: false },
    { name: 'PlatformConnect', description: 'Salesforce Connect (1-5)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 5 },
    { name: 'PlatformEncryption', description: 'Shield Platform Encryption', hasParams: false },
    { name: 'PlatformEventsPerDay', description: 'Platform events/day (10k-50k)', hasParams: true, paramType: 'number', paramMin: 10000, paramMax: 50000 },
    { name: 'ProcessBuilder', description: 'Process Builder tool', hasParams: false },
    { name: 'ProductsAndSchedules', description: 'Product schedules', hasParams: false },
    { name: 'ProductCatalogManagementAddOn', description: 'Product Catalog Management (RW)', hasParams: false },
    { name: 'ProductCatalogManagementViewerAddOn', description: 'Product Catalog Management (RO)', hasParams: false },
    { name: 'ProductCatalogManagementPCAddOn', description: 'PCM for Partner Community', hasParams: false },
    { name: 'ProgramManagement', description: 'Program & Case Management', hasParams: false },
    { name: 'ProviderFreePlatformCache', description: 'Provider Free Cache (3 MB)', hasParams: false },
    { name: 'ProviderManagement', description: 'Provider networks (Public Sector)', hasParams: false },
    { name: 'PSSAssetManagement', description: 'Asset management (Public Sector)', hasParams: false },
    { name: 'PublicSectorAccess', description: 'All Public Sector features', hasParams: false },
    { name: 'PublicSectorApplicationUsageCreditsAddOn', description: 'Public Sector app credits', hasParams: false },
    { name: 'PublicSectorSiteTemplate', description: 'Public Sector site templates', hasParams: false },
    { name: 'RateManagement', description: 'Rate Management', hasParams: false },
    { name: 'RecordTypes', description: 'Record Type functionality', hasParams: false },
    { name: 'RefreshOnInvalidSession', description: 'Auto-refresh on invalid session', hasParams: false },
    { name: 'RevSubscriptionManagement', description: 'Subscription Management', hasParams: false },
    { name: 'S1ClientComponentCacheSize', description: 'Lightning Component cache (5 pages)', hasParams: false },
    { name: 'SalesCloudEinstein', description: 'Sales Cloud Einstein', hasParams: false },
    { name: 'SalesforceContentUser', description: 'Salesforce Content access', hasParams: false },
    { name: 'SalesforceFeedbackManagementStarter', description: 'Feedback Management - Starter', hasParams: false },
    { name: 'SalesforceHostedMCP', description: 'Hosted MCP servers', hasParams: false },
    { name: 'SalesforceIdentityForCommunities', description: 'Identity components (Aura)', hasParams: false },
    { name: 'SalesforcePricing', description: 'Salesforce Pricing', hasParams: false },
    { name: 'SalesUser', description: 'Sales Cloud license', hasParams: false },
    { name: 'SAML20SingleLogout', description: 'SAML 2.0 single logout', hasParams: false },
    { name: 'SCIMProtocol', description: 'SCIM protocol support', hasParams: false },
    { name: 'ScvMultipartyAndConsult', description: 'SCV multiparty/consult calls', hasParams: false },
    { name: 'SecurityEventEnabled', description: 'Security events in monitoring', hasParams: false },
    { name: 'SentimentInsightsFeature', description: 'Sentiment Insights', hasParams: false },
    { name: 'ServiceCatalog', description: 'Employee Service Catalog', hasParams: false },
    { name: 'ServiceCloud', description: 'Service Cloud license', hasParams: false },
    { name: 'ServiceCloudVoicePartnerTelephony', description: 'SCV Partner Telephony (1-50)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 50 },
    { name: 'ServiceUser', description: 'Service Cloud User license', hasParams: false },
    { name: 'SessionIdInLogEnabled', description: 'Session IDs in Apex logs', hasParams: false },
    { name: 'SFDOInsightsDataIntegrityUser', description: 'Insights Data Integrity', hasParams: false },
    { name: 'SharedActivities', description: 'Multiple contacts per task/event', hasParams: false },
    { name: 'Sites', description: 'Salesforce Sites', hasParams: false },
    { name: 'SocialCustomerService', description: 'Social Customer Service', hasParams: false },
    { name: 'StateAndCountryPicklist', description: 'State/country picklists', hasParams: false },
    { name: 'StreamingAPI', description: 'Streaming API', hasParams: false },
    { name: 'StreamingEventsPerDay', description: 'Streaming events/day v36 (10k-50k)', hasParams: true, paramType: 'number', paramMin: 10000, paramMax: 50000 },
    { name: 'SubPerStreamingChannel', description: 'Subscribers per channel v36 (20-4000)', hasParams: true, paramType: 'number', paramMin: 20, paramMax: 4000 },
    { name: 'SubPerStreamingTopic', description: 'Subscribers per topic v36 (20-4000)', hasParams: true, paramType: 'number', paramMin: 20, paramMax: 4000 },
    { name: 'SurveyAdvancedFeatures', description: 'Feedback Management - Growth', hasParams: false },
    { name: 'SustainabilityCloud', description: 'Sustainability Cloud', hasParams: false },
    { name: 'SustainabilityApp', description: 'Net Zero Cloud', hasParams: false },
    { name: 'TalentRecruitmentManagement', description: 'Talent recruitment (Public Sector)', hasParams: false },
    { name: 'TCRMforSustainability', description: 'Net Zero Analytics', hasParams: false },
    { name: 'TimelineConditionsLimit', description: 'Timeline conditions (3)', hasParams: false },
    { name: 'TimelineEventLimit', description: 'Timeline events (5)', hasParams: false },
    { name: 'TimelineRecordTypeLimit', description: 'Timeline record types (3)', hasParams: false },
    { name: 'TimeSheetTemplateSettings', description: 'Time Sheet Templates', hasParams: false },
    { name: 'TransactionFinalizers', description: 'Apex Finalizers (Pilot)', hasParams: false },
    { name: 'UsageManagement', description: 'Usage Management', hasParams: false },
    { name: 'WaveMaxCurrency', description: 'CRM Analytics currencies (1-5)', hasParams: true, paramType: 'number', paramMin: 1, paramMax: 5 },
    { name: 'WavePlatform', description: 'Wave Platform license', hasParams: false },
    { name: 'Workflow', description: 'Workflow automation', hasParams: false },
    { name: 'WorkflowFlowActionFeature', description: 'Launch flow from workflow', hasParams: false },
    { name: 'WorkplaceCommandCenterUser', description: 'Workplace Command Center', hasParams: false },
    { name: 'WorkThanksPref', description: 'Give thanks in Chatter', hasParams: false },
];

export const COMMON_LANGUAGES = [
    { code: 'en_US', label: 'English (US)' },
    { code: 'en_GB', label: 'English (UK)' },
    { code: 'de', label: 'German' },
    { code: 'es', label: 'Spanish' },
    { code: 'fr', label: 'French' },
    { code: 'it', label: 'Italian' },
    { code: 'ja', label: 'Japanese' },
    { code: 'ko', label: 'Korean' },
    { code: 'pt_BR', label: 'Portuguese (Brazil)' },
    { code: 'zh_CN', label: 'Chinese (Simplified)' },
];

// Comprehensive Settings Categories from Salesforce documentation
// This is a curated list of the most commonly used settings with their typical boolean options
export const SETTINGS_CATEGORIES: { [key: string]: { label: string; commonOptions?: string[] } } = {
    lightningExperienceSettings: { 
        label: 'Lightning Experience', 
        commonOptions: ['enableS1DesktopEnabled'] 
    },
    mobileSettings: { 
        label: 'Mobile', 
        commonOptions: ['enableS1EncryptedStoragePref2'] 
    },
    chatterSettings: { 
        label: 'Chatter', 
        commonOptions: ['enableChatter'] 
    },
    securitySettings: { 
        label: 'Security', 
        commonOptions: ['enableAdminLoginAsAnyUser'] 
    },
    communitiesSettings: { 
        label: 'Communities (Experience Cloud)', 
        commonOptions: ['enableNetworksEnabled'] 
    },
    accountSettings: { label: 'Account Settings' },
    accountInsightsSettings: { label: 'Einstein Account Insights' },
    accountIntelligenceSettings: { label: 'Account Intelligence' },
    accountingSettings: { label: 'Accounting Subledger' },
    actionsSettings: { label: 'Actions' },
    activitiesSettings: { label: 'Activities' },
    addressSettings: { label: 'Address / State & Country Picklists' },
    analyticsSettings: { label: 'CRM Analytics' },
    apexSettings: { label: 'Apex' },
    botSettings: { label: 'Einstein Bots' },
    campaignSettings: { label: 'Campaign' },
    caseSettings: { label: 'Case' },
    companySettings: { label: 'Company' },
    connectedAppSettings: { label: 'Connected Apps' },
    contentSettings: { label: 'Content' },
    contractSettings: { label: 'Contract' },
    currencySettings: { label: 'Currency' },
    customAddressFieldSettings: { label: 'Custom Address Fields' },
    deploymentSettings: { label: 'Deployment' },
    devHubSettings: { label: 'Dev Hub' },
    eacSettings: { label: 'Einstein Activity Capture' },
    einsteinAISettings: { label: 'Einstein AI' },
    einsteinAgentSettings: { label: 'Einstein Agent' },
    einsteinGptSettings: { label: 'Einstein Generative AI' },
    emailAdministrationSettings: { label: 'Email Administration' },
    emailIntegrationSettings: { label: 'Email Integration' },
    emailTemplateSettings: { label: 'Email Templates' },
    enhancedNotesSettings: { label: 'Enhanced Notes' },
    encryptionKeySettings: { label: 'Encryption Keys' },
    entitlementSettings: { label: 'Entitlements' },
    eventSettings: { label: 'Platform Events' },
    experienceBundleSettings: { label: 'Experience Bundle', commonOptions: ['enableExperienceBundleMetadata'] },
    fieldServiceSettings: { label: 'Field Service' },
    filesConnectSettings: { label: 'Files Connect' },
    flowSettings: { label: 'Flow' },
    forecastingSettings: { label: 'Forecasting' },
    highVelocitySalesSettings: { label: 'Sales Engagement' },
    ideasSettings: { label: 'Ideas' },
    identityProviderSettings: { label: 'Identity Provider' },
    industriesSettings: { 
        label: 'Industries', 
        commonOptions: ['enableIndustriesAssessment', 'enableDiscoveryFrameworkMetadata'] 
    },
    inventorySettings: { label: 'Omnichannel Inventory' },
    invocableActionSettings: { label: 'Invocable Actions' },
    knowledgeSettings: { label: 'Knowledge' },
    languageSettings: { 
        label: 'Language', 
        commonOptions: ['enableTranslationWorkbench'] 
    },
    leadConfigSettings: { label: 'Lead Configuration' },
    leadConvertSettings: { label: 'Lead Conversion' },
    liveAgentSettings: { label: 'Chat' },
    liveMessageSettings: { label: 'Messaging' },
    macroSettings: { label: 'Macros' },
    mapAndLocationSettings: { label: 'Maps & Location' },
    meetingsSettings: { label: 'Salesforce Meetings' },
    myDomainSettings: { label: 'My Domain' },
    nameSettings: { label: 'Name Fields' },
    notificationsSettings: { label: 'Notifications' },
    opportunitySettings: { label: 'Opportunity' },
    orderManagementSettings: { label: 'Order Management' },
    orderSettings: { label: 'Order' },
    orgSettings: { label: 'Organization-Wide Settings' },
    pardotSettings: { label: 'Marketing Cloud Account Engagement' },
    pathAssistantSettings: { label: 'Path Assistant', commonOptions: ['pathAssistantEnabled'] },
    paymentsSettings: { label: 'Salesforce Payments' },
    picklistSettings: { label: 'Picklist' },
    platformEncryptionSettings: { label: 'Platform Encryption' },
    platformEventSettings: { label: 'Platform Event Settings' },
    predictionBuilderSettings: { label: 'Einstein Prediction Builder' },
    privacySettings: { label: 'Privacy' },
    productSettings: { label: 'Product' },
    quoteSettings: { label: 'Quote' },
    recordPageSettings: { label: 'Record Page' },
    revenueManagementSettings: { label: 'Revenue Cloud', commonOptions: ['enableCoreCPQ'] },
    salesAgreementSettings: { label: 'Sales Agreement' },
    sandboxSettings: { label: 'Sandbox' },
    schemaSettings: { label: 'Schema' },
    searchSettings: { label: 'Search' },
    sharingSettings: { label: 'Sharing' },
    siteSettings: { label: 'Sites' },
    subscriptionManagementSettings: { label: 'Subscription Management' },
    surveySettings: { label: 'Survey' },
    territory2Settings: { label: 'Territory Management' },
    trailheadSettings: { label: 'Trailhead / myTrailhead' },
    userEngagementSettings: { 
        label: 'User Engagement', 
        commonOptions: ['enableOrchestrationInSandbox'] 
    },
    userInterfaceSettings: { label: 'User Interface' },
    userManagementSettings: { label: 'User Management' },
    voiceSettings: { label: 'Sales Dialer' },
    workDotComSettings: { label: 'Work.com' },
};

/**
 * Parse a feature string into name and parameter
 */
export function parseFeature(feature: string): { name: string; param?: string } {
    const colonIndex = feature.indexOf(':');
    if (colonIndex === -1) {
        return { name: feature };
    }
    return {
        name: feature.substring(0, colonIndex),
        param: feature.substring(colonIndex + 1)
    };
}

/**
 * Build a feature string from name and parameter
 */
export function buildFeature(name: string, param?: string): string {
    return param ? `${name}:${param}` : name;
}

/**
 * Validate scratch org definition
 */
export function validateDefinition(def: ScratchOrgDefinition): string[] {
    const errors: string[] = [];
    
    if (!def.edition) {
        errors.push('Edition is required');
    }
    
    if (def.features) {
        for (const feature of def.features) {
            const parsed = parseFeature(feature);
            const featureInfo = ALL_FEATURES.find(f => f.name === parsed.name);
            
            if (featureInfo && featureInfo.hasParams && featureInfo.paramType === 'number' && parsed.param) {
                const num = parseInt(parsed.param);
                if (isNaN(num)) {
                    errors.push(`Feature ${parsed.name} requires a numeric parameter`);
                }
                if (featureInfo.paramMax && num > featureInfo.paramMax) {
                    errors.push(`Feature ${parsed.name} parameter cannot exceed ${featureInfo.paramMax}`);
                }
                if (featureInfo.paramMin && num < featureInfo.paramMin) {
                    errors.push(`Feature ${parsed.name} parameter must be at least ${featureInfo.paramMin}`);
                }
            }
        }
    }
    
    return errors;
}
