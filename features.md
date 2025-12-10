Scratch Org Features
The scratch org definition file contains the configuration values that determine the shape of the scratch org. You can enable these supported add-on features in a scratch org.
Note

Some scratch org features require a license or permissions in the Dev Hub org. If you can’t create the scratch org by just specifying the feature name in the scratch org definition file, see your Salesforce admin for assistance.

Supported Features
Features aren’t case-sensitive. You can indicate them as all-caps, or as we define them here for readability. If a feature is followed by <value>, you must specify a value as an incremental allocation or limit.

You can specify multiple feature values in a comma-delimited list in the scratch org definition file.
"features": ["ServiceCloud", "API", "AuthorApex"],
AccountInspection
Enables the Account Intelligence view. The Account Intelligence view is a consolidated dashboard showing account metrics, activities, and related opportunities and cases.
AccountingSubledgerGrowthEdition
Provides three permission sets that enable access to Accounting Subledger Growth features.
AccountingSubledgerStarterEdition
Provides three permission sets that enable access to Accounting Subledger Starter features.
AccountingSubledgerUser
Enables organization-wide access to Accounting Subledger Growth features when the package is installed.
AddCustomApps:<value>
Increases the maximum number of custom apps allowed in an org. Indicate a value from 1–30.
AddCustomObjects:<value>
Increases the maximum number of custom objects allowed in the org. Indicate a value from 1–30.
AddCustomRelationships:<value>
Increases the maximum number of custom relationships allowed on an object. Indicate a value from 1–10.
AddCustomTabs:<value>
Increases the maximum number of custom tabs allowed in an org. Indicate a value from 1–30.
AddDataComCRMRecordCredit:<value>
Increases record import credits assigned to a user in your scratch org. Indicate a value from 1–30.
AddInsightsQueryLimit:<value>
Increases the size of your CRM Analytics query results. Indicate a value from 1–30 (multiplier is 10). Setting the quantity to 6 increases the query results to 60.
AdditionalFieldHistory:<value>
Increases the number of fields you can track history for beyond the default, which is 20 fields. Indicate a value between 1–40.
AdmissionsConnectUser
Enables the Admissions Connect components. Without this scratch org feature parameter, the custom Admissions Connect components render as blank.
AdvisorLinkFeature
Enables the Student Success Hub components. Without this scratch org feature parameter, the custom Student Success Hub components render as blank.
AdvisorLinkPathwaysFeature
Enables the Pathways components. Without this scratch org feature parameter, the custom Pathways components render as blank.
AIAttribution
Provides access to Einstein Attribution for Marketing Cloud Account Engagement. Einstein Attribution uses AI modeling to dynamically assign attribution percentages to multiple campaign touchpoints.
AllUserIdServiceAccess
Enables all users to access all users’ information via the user ID service.
AnalyticsAdminPerms
Enables all permissions required to administer the CRM Analytics platform, including permissions to enable creating CRM Analytics templated apps and CRM Analytics Apps.
AnalyticsAppEmbedded
Provides one CRM Analytics Embedded App license for the CRM Analytics platform.
ApexGuruCodeAnalyzer
Enables ApexGuru's generative AI-powered runtime insights in Salesforce Code Analyzer, which delivers Apex code quality recommendations directly in developer IDEs.
API
Even in the editions (Professional, Group) that don’t provide API access, REST API is enabled by default. Use this scratch org feature to access additional APIs (SOAP, Streaming, Bulk, Bulk 2.0).
ArcGraphCommunity
Lets you add Actionable Relationship Center (ARC) components to Experience Cloud pages so your users can view ARC Relationship Graphs.
Assessments
Enables dynamic Assessments features, which enables both Assessment Questions and Assessment Question Sets.
AssetScheduling:<value>
Enables Asset Scheduling license. Asset Scheduling makes it easier to book rooms and equipments. Indicate a value between 1–10.
AssociationEngine
Enables the Association Engine, which automatically associates new accounts with the user’s current branch by creating branch unit customer records.
AuthorApex
Enables you to access and modify Apex code in a scratch org. Enabled by default in Enterprise and Developer Editions.
B2BCommerce
Provides the B2B License. B2BCommerce enables business-to-business (B2B) commerce in your org. Create and update B2B stores. Create and manage buyer accounts. Sell products to other businesses.
B2BLoyaltyManagement
Enables the B2B Loyalty Management license. Create loyalty programs and set up loyalty program-specific processes that allow you to recognize, rewards, and retain customers.
B2CCommerceGMV
Provides the B2B2C Commerce License. B2B2C Commerce allows you to quickly stand up an ecommerce site to promote brands and sell products into multiple digital channels. You can create and update retail storefronts in your org, and create and manage person accounts.
B2CLoyaltyManagement
Enables the Loyalty Management - Growth license. Create loyalty programs and set up loyalty program-specific processes that allow you to recognize, rewards, and retain customers.
B2CLoyaltyManagementPlus
Enables the Loyalty Management - Advanced license. Create loyalty programs and set up loyalty program-specific processes that allow you to recognize, rewards, and retain customers.
BatchManagement
Enables the Batch Management license. Batch Management allows you to process a high volume of records in manageable batches.
BenefitManagement
Enables the objects, features, and permissions for managing benefits programs, benefit disbursements, and benefit applicant tracking in Public Sector Solutions.
BigObjectsBulkAPI
Enables the scratch org to use BigObjects in the Bulk API.
BillingAdvanced
Enables access to all the Billing features and objects that are available with the Revenue Cloud Billing license in the scratch org.
Briefcase
Enables the use of Briefcase Builder in a scratch org, which allows you to create offline briefcases that make selected records available for viewing offline.
BudgetManagement
Gives users access to budget management features and objects. To enable budget management, add this feature to your scratch org definition file.
BusinessRulesEngine
Enables Business Rules Engine, which enables both expression sets and lookup tables.
BYOCCaaS
Enables you to set up and test a partner contact center that integrates with supported Contact Center as a Service (CCaaS) providers in your scratch org.
BYOOTT
Enables you to set up and test a Bring Your Own Channel for Messaging channel that integrates with supported Messaging providers in your scratch org.
CacheOnlyKeys
Enables the cache-only keys service. This feature allows you to store your key material outside of Salesforce, and have the Cache-Only Key Service fetch your key on demand from a key service that you control.
CalloutSizeMB:<value>
Increases the maximum size of an Apex callout. Indicate a value between 3–12.
CampaignInfluence2
Provides access to Customizable Campaign Influence for Sales Cloud and Marketing Cloud Account Engagement. Customizable Campaign Influence can auto-associate or allow manual creation of relationships among campaigns and opportunities to track attribution.
CascadeDelete
Provides lookup relationships with the same cascading delete functionality previously only available to master-detail relationships. To prevent records from being accidentally deleted, cascade-delete is disabled by default.
CaseClassification
Enables Einstein Case Classification. Case Classification offers recommendations to your agents so they can select the best value. You can also automatically save the best recommendation and route the case to the right agent.
CaseWrapUp
Enables Einstein Case Wrap-Up. To help agents complete cases quickly, Einstein Case Wrap-Up recommends case field values based on past chat transcripts.
CGAnalytics
Enables the Consumer Goods Analytics org perm in scratch orgs.
ChangeDataCapture
Enables Change Data Capture, if the scratch org edition doesn't automatically enable it.
Chatbot
Enables deployment of Bot metadata into a scratch org, and allows you to create and edit bots.
ChatterEmailFooterLogo
ChatterEmailFooterLogo allows you to use the Document ID of a logo image, which you can use to customize chatter emails.
ChatterEmailFooterText
ChatterEmailFooterText allows you to use footer text in customized Chatter emails.
ChatterEmailSenderName
ChatterEmailSenderName allows you to customize the name that appears as the sender’s name in the email notification. For example, your company’s name.
CloneApplication
CloneApplication allows you to clone an existing custom Lightning app and make required customizations to the new app. This way, you don’t have to start from scratch, especially when you want to create apps with simple variations.
CMSMaxContType
Limits the number of distinct content types you can create within Salesforce CMS to 21.
CMSMaxNodesPerContType
Limits the maximum number of child nodes (fields) you can create for a particular content type to 15.
CMSUnlimitedUse
Enables unlimited content records, content types, and bandwidth usage in Salesforce CMS.
Communities
Allows the org to create an Experience Cloud site. Experience Cloud uses the term Communities in its configuration. To use Communities, you must also include communitiesSettings > enableNetworksEnabled in the settings section of your scratch org definition file.
CompareReportsOrgPerm
Enables the org permission to allow for comparison of Lightning Reports.
ConAppPluginExecuteAsUser
Enables the pluginExecutionUser field in the ConnectedApp Metadata API object.
ConcStreamingClients:<value>
Increases the maximum number of concurrent clients (subscribers) across all channels and for all event types for API version 36.0 and earlier. Indicate a value between 20–4,000.
ConnectedAppCustomNotifSubscription
Enables connected apps to subscribe to custom notification types, which are used to send custom desktop and mobile notifications.
ConnectedAppToolingAPI
Enables the use of connected apps with the Tooling API.
ConsentEventStream
Enables the Consent Event Stream permission for the org.
ConsolePersistenceInterval:<value>
Increases how often console data is saved, in minutes. Indicate a value between 0–500. To disable auto save, set the value to 0.
ContactsToMultipleAccounts
Enables the contacts to multiple accounts feature. This feature lets you relate a contact to two or more accounts.
ContractApprovals
Enables contract approvals, which allow you to track contracts through an approval process.
ContractManagement
Enables the Contract Lifecycle (CLM) Management features in the org.
ContractMgmtInd
Enables the Contract Lifecycle Management (CLM) features for Industries.
CoreCpq
Enables read-write access to Revenue Cloud features and objects. To use Revenue Cloud, you must also include revenueManagementSettings > enableCoreCPQ in the settings section of your scratch org definition file.
CPQ
Enables the licensed features required to install the Salesforce CPQ managed package but doesn't install the package automatically.
CustomerDataPlatform
Enables the CustomerDataPlatform license in scratch orgs.
CustomerDataPlatformLite
Enables the Data Cloud license in scratch orgs. You must also include the CustomerDataPlatform feature and enableCustomerDataPlatform Metadata API setting in your scratch org definition.
CustomerExperienceAnalytics
Enables the Customer Lifecycle Analytics org perm in scratch orgs.
CustomFieldDataTranslation
Enables translation of custom field data for Work Type Group, Service Territory, and Service Resource objects. You can enable data translation for custom fields with Text, Text Area, Text Area (Long), Text Area (Rich), and URL types.
CustomNotificationType
Allows the org to create custom notification types, which are used to send custom desktop and mobile notifications.
DataComDnbAccounts
Provides a license to Data.com account features.
DataComFullClean
Provides a license to Data.com cleaning features, and allows users to turn on auto fill clean settings for jobs.
DataMaskUser
Provides 30 Data Mask permission set licenses. This permission set enables access to an installed Salesforce Data Mask package.
DataProcessingEngine
Enables the Data Processing Engine license. Data Processing Engine helps transform data that's available in your Salesforce org and write back the transformation results as new or updated records.
DebugApex
Enables Apex Interactive Debugger. You can use it to debug Apex code by setting breakpoints and checkpoints, and inspecting your code to find bugs.
DecisionTable
Enables Decision Table license. Decision tables read business rules and decide the outcome for records in your Salesforce org or for the values that you specify.
DefaultWorkflowUser
Sets the scratch org admin as the default workflow user.
DeferSharingCalc
Allows admins to suspend group membership and sharing rule calculations and to resume them later.
DevelopmentWave
Enables CRM Analytics development in a scratch org. It assigns five platform licenses and five CRM Analytics platform licenses to the org, along with assigning the permission set license to the admin user. It also enables the CRM Analytics Templates and Einstein Discovery features.
DeviceTrackingEnabled
Enables Device Tracking.
DevOpsCenter
Enables DevOps Center in scratch orgs so that partners can create second-generation managed packages that extend or enhance the functionality in the DevOps Center application (base) package.
DisableManageIdConfAPI
Limits access to the LoginIP and ClientBrowser API objects to allow view or delete only.
DisclosureFramework
Provides the permission set licenses and permission sets required to configure Disclosure and Compliance Hub.
Division
Turns on the Manage Divisions feature under Company Settings. Divisions let you segment your organization's data into logical sections, making searches, reports, and list views more meaningful to users. Divisions are useful for organizations with extremely large amounts of data.
DocGen
Enables the Document Generation Feature in the Org.
DocGenDesigner
Enables the designers to create and configure document templates.
DocGenInd
Enables the Industry Document Generation features in the org.
DocumentChecklist
Enables Document Tracking and Approval features, and adds the Document Checklist permission set. Document tracking features let you define documents to upload and approve, which supports processes like loan applications or action plans.
DocumentReaderPageLimit
Limits the number of pages sent for data extraction to 5.
DSARPortability
Enables an org to access the DSARPortability feature in Privacy Center. Also, provides one seat each of the PrivacyCenter and PrivacyCenterAddOn licenses.
DurableClassicStreamingAPI
Enables Durable PushTopic Streaming API for API version 37.0 and later.
DurableGenericStreamingAPI
Enables Durable Generic Streaming API for API version 37.0 and later.
DynamicClientCreationLimit
Allows the org to register up to 100 OAuth 2.0 connected apps through the dynamic client registration endpoint.
EAndUDigitalSales
Enables the Energy and Utilities Digital Sales feature in the org.
EAndUSelfServicePortal
Enables the Self Service Portal features for Digital Experience users in the org.
EAOutputConnectors
Enable CRM Analytics Output Connectors.
EASyncOut
Enable CRM Analytics SyncOut.
EdPredictionM3Threshold
Sets the number of records in the payload to 10, after which the Einstein Discovery prediction service uses M3.
EdPredictionTimeout
Sets the maximum duration of a single Einstein Discovery prediction to 100 milliseconds.
EdPredictionTimeoutBulk
Sets the maximum duration of a single Einstein Discovery prediction when it runs in bulk to 10 milliseconds.
EdPredictionTimeoutByomBulk
Sets the maximum duration of a single Bring Your Own Model (BYOM) Einstein Discovery prediction to 100 milliseconds.
EducationCloud: <value>
Enables use of Education Cloud.
Einstein1AIPlatform
Provides access to Einstein generative AI features such as Agentforce, Prompt Builder, Model Builder, and the Models API. To use generative AI features, you must also include einsteinGptSettings > enableEinsteinGptPlatform in the settings section of your scratch org definition file.
EinsteinAnalyticsPlus
Provides one CRM Analytics Plus license for the CRM Analytics platform.
EinsteinArticleRecommendations
Provides licenses for Einstein Article Recommendations. Einstein Article Recommendations uses data from past cases to identify Knowledge articles that are most likely to help your customer service agents address customer inquiries.
EinsteinBuilderFree
Provides a license that allows admins to create one enabled prediction with Einstein Prediction Builder. Einstein Prediction Builder is custom AI for admins
EinsteinDocReader
Provides the license required to enable and use Intelligent Form Reader in a scratch org. Intelligent Form Reader uses optical character recognition to automatically extract data with Amazon Textract.
EinsteinRecommendationBuilder
Provides a license to create recommendations with Einstein Recommendation Builder. Einstein Recommendation Builder lets you build custom AI recommendations.
EinsteinSearch
Provides the license required to use and enable Einstein Search features in a scratch org.
EinsteinVisits
Enables Consumer Goods Cloud. With Consumer Goods cloud, transform the way you collaborate with your retail channel partners. Empower your sales managers to plan visits and analyze your business’s health across stores. Also, allow your field reps to track inventory, take orders, and capture visit details using the Retail Execution mobile app.
EinsteinVisitsED
Enables Einstein Discovery, which can be used to get store visit recommendations. With Einstein Visits ED, you can create a visit frequency strategy that allows Einstein to provide optimal store visit recommendations.
EmbeddedLoginForIE
Provides JavaScript files that support Embedded Login in IE11.
EmpPublishRateLimit:<value>
Increases the maximum number of standard-volume platform event notifications published per hour. Indicate a value between 1,000–10,000.
EnablePRM
Enables the partner relationship management permissions for the org.
EnableManageIdConfUI
Enables access to the LoginIP and ClientBrowser API objects to verify a user's identity in the UI.
Enablement
Enables features for creating, taking, and tracking sales programs with Enablement. Business operations experts and sales leaders identify the revenue outcomes they want sales reps to achieve, such as increased average deal sizes or shorter ramp times. Then, they create programs that help sales reps work towards those outcomes as part of their daily work.
EnableSetPasswordInApi
Enables you to use sf org generate password to change a password without providing the old password.
EncryptionStatisticsInterval:<value>
Defines the interval (in seconds) between encryption statistics gathering processes. The maximum value is 604,800 seconds (7 days). The default is once per 86,400 seconds (24 hours).
EncryptionSyncInterval:<value>
Defines how frequently (in seconds) the org can synchronize data with the active key material. The default and maximum value is 604,800 seconds (7 days). To synchronize data more frequently, indicate a value, in seconds, equal to or larger than 0.
EnergyAndUtilitiesCloud
Enables the Energy and Utilities Cloud features in the org.
Entitlements
Enables entitlements. Entitlements are units of customer support in Salesforce, such as phone support or web support that represent terms in service agreements.
ERMAnalytics
Enables the ERM Analytics org perm in your scratch org.
EventLogFile
Enables API access to your org's event log files. The event log files contain information about your org’s operational events that you can use to analyze usage trends and user behavior.
EntityTranslation
Enables translation of field data for Work Type Group, Service Territory, and Service Resource objects.
ExcludeSAMLSessionIndex
Excludes Session Index in SAML sign-on (SSO) and single logout (SLO) flows.
Explainability
Enables an org to use Decision Explainer features.
ExpressionSetMaxExecPerHour
Enables an org to run a maximum of 500,000 expression sets per hour by using Connect REST API.
ExternalIdentityLogin
Allows the scratch org to use Salesforce Customer Identity features associated with your External Identity license.
FieldAuditTrail
Enables Field Audit Trail for the org and allows a total 60 tracked fields. By default, 20 fields are tracked for all orgs, and 40 more are tracked with Field Audit Trail.
FieldService:<value>
Provides the Field Service license. Indicate a value between 1–25.
FieldServiceAppointmentAssistantUser:<value>
Adds the Field Service Appointment Assistant permission set license. Indicate a value between 1–25.
FieldServiceDispatcherUser:<value>
Adds the Field Service Dispatcher permission set license. Indicate a value between 1–25.
FieldServiceLastMileUser:<value>
Adds the Field Service Last Mile permission set license. Indicate a value between 1–25.
FieldServiceMobileExtension
Adds the Field Service Mobile Extension permission set license.
FieldServiceMobileUser:<value>
Adds the Field Service Mobile permission set license. Indicate a value between 1–25.
FieldServiceSchedulingUser:<value>
Adds the Field Service Scheduling permission set license. Indicate a value between 1–25.
FinanceLogging
Adds Finance Logging objects to a scratch org. This feature is required for Finance Logging.
FinancialServicesCommunityUser:<value>
Adds the Financial Services Insurance Community permission set license, and enables access to Financial Services insurance community components and objects. Indicate a value between 1–10.
FinancialServicesInsuranceUser
Adds the Financial Services Insurance permission set license, and enables access to Financial Services insurance components and objects.
FinancialServicesUser:<value>
Adds the Financial Services Cloud Standard permission set license. This permission set enables access to Lightning components and the standard version of Financial Services Cloud. Also provides access to the standard Salesforce objects and custom Financial Services Cloud objects. Indicate a value between 1–10.
FlowSites
Enables the use of flows in Salesforce Sites and customer portals.
ForceComPlatform
Adds one Salesforce Platform user license.
ForecastEnableCustomField
Enables custom currency and customer number fields for use as measures in forecasts based on opportunities.
FSCAlertFramework
Makes Financial Services Cloud Record Alert entities accessible in the scratch org.
FSCServiceProcess
Enables the Service Process Studio feature of Financial Service Cloud. Provides 10 seats each of the IndustriesServiceExcellenceAddOn and FinancialServicesCloudStardardAddOn licenses. To enable the feature, you must also turn on the StandardServiceProcess setting in Setup and grant users the AccessToServiceProcess permission.
Fundraising
Gives users access to Nonprofit Cloud for Fundraising features and objects in Salesforce.
GenericStreaming
Enables Generic Streaming API for API version 36.0 and earlier.
GenStreamingEventsPerDay:<value>
Increases the maximum number of delivered event notifications within a 24-hour period, shared by all CometD clients, with generic streaming for API version 36.0 and earlier. Indicate a value between 10,000–50,000.
Grantmaking
Gives users access to Grantmaking features and objects in Salesforce and Experience Cloud.
GuidanceHubAllowed
Enables the Guidance Center panel in Lightning Experience. The Guidance Center shows suggested and assigned content in the user’s flow of work. Suggested content is related to the app or page where the user is working. Assigned content includes guidance sets for Salesforce admins, links or Trailhead modules assigned to users with Learning Paths, and Enablement programs for sales reps.
HealthCloudAddOn
Enables use of Health Cloud.
HealthCloudEOLOverride
Salesforce retired the Health Cloud CandidatePatient object in Spring ‘22 to focus on the more robust Lead object. This scratch org feature allows you to override that retirement and access the object.
HealthCloudForCmty
Enables use of Health Cloud for Experience Cloud Sites.
HealthCloudMedicationReconciliation
Allows Medication Management to support Medication Reconciliation.
HealthCloudPNMAddOn
Enables use of Provider Network Management.
HealthCloudUser
This enables the scratch org to use the Health Cloud objects and features equivalent to the Health Cloud permission set license for one user.
HighVelocitySales
Provides Sales Engagement licenses and enables Salesforce Inbox. Sales Engagement optimizes the inside sales process with a high-productivity workspace. Sales managers can create custom sales processes that guide reps through handling different types of prospects. And sales reps can rapidly handle prospects with a prioritized list and other productivity-boosting features. The Sales Engagement feature can be deployed in scratch orgs, but the settings for the feature can’t be updated through the scratch org definition file. Instead, configure settings directly in the Sales Engagement app.
HighVolumePlatformEventAddOn
Increases the daily delivery allocation of high-volume platform events or change data capture events by 100,000 events. This scratch org feature simulates the purchase of an add-on. If the org has the HighVolumePlatformEventAddOn, the daily allocation is flexible and isn’t enforced strictly to allow for usage peaks.
HLSAnalytics
Enables the HLS Analytics org perm in scratch orgs.
HoursBetweenCoverageJob:<value>
The frequency in hours when the sharing inheritance coverage report can be run for an object. Indicate a value between 1–24.
IdentityProvisioningFeatures
Enables use of Salesforce Identity User Provisioning.
IgnoreQueryParamWhitelist
Ignores allowlisting rules for query parameter filter rules. If enabled, you can add any query parameter to the URL.
IndustriesActionPlan
Provides a license for Action Plans. Action Plans allow you to define the tasks or document checklist items for completing a business process.
IndustriesBranchManagement
Branch Management lets branch managers and administrators track the work output of branches, employees, and customer segments in Financial Services Cloud.
IndustriesCompliantDataSharing
Grants users access to participant management and advanced configuration for data sharing to improve compliance with regulations and company policies.
IndustriesMfgAdvncdAccFrcs
Enables Advanced Account Forecasting. With Advanced Account Forecasting, generate comprehensive, multi-horizon forecasts for sales, operations, inventory, service, and other aspects of your business. Tailor your forecasting configurations to your objectives to generate accurate, relevant forecasts.
IndustriesMfgPartnerVisitMgmt
Enables Partner Visit Management. Partner Visit Management helps sales managers in your company schedule visits to partner and distributor locations. Sales managers can use those visits to monitor performance, arrange for periodic check-ins, conduct trainings, upsell and cross-sell products, and follow up on sales agreement renewals and warranty expiration.
IndustriesMfgProgram
Enables Program Based Business. With Program Based Business, program managers can manage the end-to-end lifecycle of a program where they derive forecasts based on their customers’ forecasts, transform these forecasts into business opportunities, and convert those opportunities into run-rate business. Program based business is common across multiple industries such as process, aerospace, defense, automotive, engineer-to-order, and make-to-order environments.
IndustriesMfgRebates
Enables Rebate Management. Manage incentive programs, track rebate attainment, automate payouts, and gain insights into sales performance and program effectiveness.
IndustriesMfgTargets
Enables Sales Agreements. With Sales Agreements, you can negotiate purchase and sale of products over a continued period. You can also get insights into products, prices, discounts, and quantities. And you can track your planned and actual quantities and revenues with real-time updates from orders and contracts.
IndustriesManufacturingCmty
Provides the Manufacturing Sales Agreement for the Community permission set license, which is intended for the usage of partner community users. It also provides access to the Manufacturing community template for admins users to create communities.
IndustriesMfgAccountForecast
Enables Account Forecast. With Account Forecast, you can generate forecasts for your accounts based on orders, opportunities, and sales agreements. You can also create formulas to calculate your forecasts per the requirements of your company.
InsightsPlatform
Enables the CRM Analytics Plus license for CRM Analytics.
InsuranceCalculationUser
Enables the calculation feature of Insurance. Provides 10 seats each of the BRERuntimeAddOn and OmniStudioRuntime licenses. Also, provides one seat each of the OmniStudio and BREPlatformAccess licenses.
InsuranceClaimMgmt
Enables claim management features. Provides one seat of the InsuranceClaimMgmtAddOn license.
InsurancePolicyAdmin
Enables policy administration features. Provides one seat of the InsurancePolicyAdministrationAddOn license.
IntelligentDocumentReader
Provides the license required to enable and use Intelligent Document Reader in a scratch org. Intelligent Document Reader uses optical character recognition to automatically extract data with Amazon Textract by using your AWS account.
InvestigativeCaseManagement
Enables the objects, features, and permissions for managing investigative cases, including evidence management and case proceedings, in Public Sector Solutions.
InvoiceManagement
Enables access to all the Billing features and objects that are available with the Revenue Cloud Advanced license in the scratch org.
Interaction
Enables flows. A flow is the part of Salesforce Flow that collects data and performs actions in your Salesforce org or an external system. Salesforce Flow provides two types of flows: screen flows and autolaunched flows.
IoT
Enables IoT so the scratch org can consume platform events to perform business and service workflows using orchestrations and contexts.
JigsawUser
Provides one license to Jigsaw features.
Knowledge
Enables Salesforce Knowledge and gives your website visitors, clients, partners, and service agents the ultimate support tool. Create and manage a knowledge base with your company information, and securely share it when and where it's needed. Build a knowledge base of articles that can include information on process, like how to reset your product to its defaults, or frequently asked questions.
LegacyLiveAgentRouting
Enables legacy Live Agent routing for Chat. Use Live Agent routing to chat in Salesforce Classic. Chats in Lightning Experience must be routed using Omni-Channel.
LightningSalesConsole
Adds one Lighting Sales Console user license.
LightningScheduler
Enables Lightning Scheduler. Lightning Scheduler gives you tools to simplify appointment scheduling in Salesforce. Create a personalized experience by scheduling customer appointments—in person, by phone, or by video—with the right person at the right place and time.
LightningServiceConsole
Assigns the Lightning Service Console License to your scratch org so you can use the Lightning Service Console and access features that help manage cases faster.
LiveAgent
Enables Chat for Service Cloud. Use web-based chat to quickly connect customers to agents for real-time support.
LiveMessage
Enables Messaging for Service Cloud. Use Messaging to quickly support customers using apps such as SMS text messaging and Facebook Messenger.
LongLayoutSectionTitles
Allows page layout section titles to be up to 80 characters.
LoyaltyAnalytics
Enables Analytics for Loyalty license. The Analytics for Loyalty app gives you actionable insights into your loyalty programs.
LoyaltyEngine
Enables Loyalty Management Promotion Setup license. Promotion setup allows loyalty program managers to create loyalty program processes. Loyalty program processes help you decide how incoming and new Accrual and Redemption-type transactions are processed.
LoyaltyManagementStarter
Enables the Loyalty Management - Starter license. Create loyalty programs and set up loyalty program-specific processes that allow you to recognize, rewards, and retain customers.
LoyaltyMaximumPartners:<value>
Increases the number of loyalty program partners that can be associated with a loyalty program in an org where the Loyalty Management - Starter license is enabled. The default and maximum value is 1.
LoyaltyMaximumPrograms:<value>
Increases the number of loyalty programs that can be created in an org where the Loyalty Management - Starter license is enabled. The default and maximum value is 1.
LoyaltyMaxOrderLinePerHour:<value>
Increases the number of order lines that can be cumulatively processed per hour by loyalty program processes. Indicate a value between 1–3,500,000.
LoyaltyMaxProcExecPerHour:<value>
Increases the number of transaction journals that can be processed by loyalty program processes per hour. Indicate a value between 1–500,000.
LoyaltyMaxTransactions:<value>
Increases the number of Transaction Journal records that can be processed. Indicate a value between 1–50,000,000.
LoyaltyMaxTrxnJournals:<value>
Increases the number of Transaction Journal records that can be stored in an org that has the Loyalty Management - Start license enabled.
Macros
Enables macros in your scratch org. After enabling macros, add the macro browser to the Lightning Console so you can configure predefined instructions for commonly used actions and apply them to multiple posts at the same time.
MarketingCloud
Provides licenses for Marketing Cloud Growth edition. These licenses provide access to campaigns, flows, emails, forms, landing pages, and consent management features. You can send up to 20 emails per day from a scratch org.
MarketingUser
Provides access to the Campaigns object. Without this setting, Campaigns are read-only.
MaterialityAssessment
Provides the permission set licenses and permission sets required to configure materiality assessment in Net Zero Cloud.
MaxActiveDPEDefs:<value>
Increases the number of Data Processing Engine definitions that can be activated in the org. Indicate a value between 1–50.
MaxApexCodeSize:<value>
Limits the non-test, unmanaged Apex code size (in MB). To use a value greater than the default value of 10, contact Salesforce Customer Support.
MaxAudTypeCriterionPerAud
Limits the number of audience type criteria available per audience. The default value is 10.
MaxCustomLabels:<value>
Limits the number of custom labels (measured in thousands). Setting the limit to 10 enables the scratch org to have 10,000 custom labels. Indicate a value between 1–15.
MaxDatasetLinksPerDT:<value>
Increases the number of dataset links that can be associated with a decision table. Indicate a value between 1–3.
MaxDataSourcesPerDPE:<value>
Increases the number of Source Object nodes a Data Processing Engine definition can contain. Indicate a value between 1–50.
MaxDecisionTableAllowed:<value>
Increases the number of decision tables rules that can be created in the org. Indicate a value between 1–30.
MaxFavoritesAllowed:<value>
Increases the number of Favorites allowed. Favorites allow users to create a shortcut to a Salesforce Page. Users can view their Favorites by clicking the Favorites list dropdown in the header. Indicate a value between 0–200.
MaxFieldsPerNode:<value>
Increases the number of fields a node in a Data Processing Engine definition can contain. Indicate a value between 1–500.
MaxInputColumnsPerDT:<value>
Increases the number of input fields a decision table can contain. Indicate a value between 1–10.
MaxLoyaltyProcessRules:<value>
Increases the number of loyalty program process rules that can be created in the org. Indicate a value between 1–20.
MaxNodesPerDPE:<value>
Increases the number of nodes that a Data Processing Engine definition can contain. Indicate a value between 1–500.
MaxNoOfLexThemesAllowed:<value>
Increases the number of Themes allowed. Themes allow users to configure colors, fonts, images, sizes, and more. Access the list of Themes in Setup, under Themes and Branding. Indicate a value between 0–300.
MaxOutputColumnsPerDT:<value>
Increases the number of output fields a decision table can contain. Indicate a value between 1–5.
MaxSourceObjectPerDSL:<value>
Increases the number of source objects that can be selected in a dataset link of a decision table. Indicate a value between 1–5.
MaxStreamingTopics:<value>
Increases the maximum number of delivered PushTopic event notifications within a 24-hour period, shared by all CometD clients. Indicate a value between 40–100.
MaxUserNavItemsAllowed:<value>
Increases the number of navigation items a user can add to the navigation bar. Indicate a value between 0–500.
MaxUserStreamingChannels:<value>
Increases the maximum number of user-defined channels for generic streaming. Indicate a value between 20–1,000.
MaxWishlistsItemsPerWishlist
Limits the number of wishlist items per wishlist. The default value is 500.
MaxWishlistsPerStoreAccUsr
Limits the number of wishlists allowed per store, account, and user. The default value is 100.
MaxWritebacksPerDPE:<value>
Increases the number of Writeback Object nodes a Data Processing Engine definition can contain. Indicate a value between 1–50.
MedVisDescriptorLimit:<value>
Increases the number of sharing definitions allowed per record for sharing inheritance to be applied to an object. Indicate a value between 150–1,600.
MinKeyRotationInterval
Sets the encryption key material rotation interval at once per 60 seconds. If this feature isn't specified, the rotation interval defaults to once per 604,800 seconds (7 days) for Search Index key material, and once per 86,400 seconds (24 hours) for all other key material.
MobileExtMaxFileSizeMB:<value>
Increases the file size (in megabytes) for Field Service Mobile extensions. Indicate a value between 1–2,000.
MobileSecurity
Enables Enhanced Mobile Security. With Enhanced Mobile Security, you can control a range of policies to create a security solution tailored to your org’s needs. You can limit user access based on operating system versions, app versions, and device and network security. You can also specify the severity of a violation.
MobileVoiceAndLLM
Allows mobile apps to download large language models (LLMs) and voice models for offline use from the model store service. Normally, mobile apps have access to the model store service when Einstein is enabled, but the MobileVoiceAndLLM scratch org feature enables offline voice without requiring orgs to fully enable Einstein.
MultiLevelMasterDetail
Allows the creation a special type of parent-child relationship between one object, the child, or detail, and another object, the parent, or master.
MutualAuthentication
Requires client certificates to verify inbound requests for mutual authentication.
MyTrailhead
Enables access to a myTrailhead enablement site in a scratch org.
NonprofitCloudCaseManagementUser
Provides the permission set license required to use and configure the Salesforce.org Nonprofit Cloud Case Management managed package. You can then install the package in the scratch org.
NumPlatformEvents:<value>
Increases the maximum number of platform event definitions that can be created. Indicate a value between 5–20.
ObjectLinking
Create rules to quickly link channel interactions to objects such as contacts, leads, or person accounts for customers (Beta).
OmnistudioMetadata
Enables Omnistudio metadata API. Using this API, customers can deploy and retrieve Omnistudio components programmatically. 
OmnistudioRuntime
Enables business users to execute OmniScripts, DataMappers, FlexCards, and so on in the employee facing applications.
OmnistudioDesigner
Enables administrator or developer to create new OmniScripts/ DataMappers / Integration Procedures instances.
OrderManagement
Provides the Salesforce Order Management license. Order Management is your central hub for handling all aspects of the order lifecycle, including order capture, fulfillment, shipping, payment processing, and servicing.
OrderSaveLogicEnabled
Enables scratch org support for New Order Save Behavior. OrderSaveLogicEnabled supports only New Order Save Behavior. If your scratch org needs both Old and New Order Save Behavior, use OrderSaveBehaviorBoth.
OrderSaveBehaviorBoth
Enables scratch org support for both New Order Save Behavior and Old Order Save Behavior.
OutboundMessageHTTPSession
Enables using HTTP endpoint URLs in outbound message definitions that have the Send Session ID option selected.
OutcomeManagement
Gives users access to Outcome Management features and objects in Salesforce and Experience Cloud.
PardotScFeaturesCampaignInfluence
Enables additional campaign influence models, first touch, last touch, and even distribution for Pardot users.
PersonAccounts
Enables person accounts in your scratch org.
PipelineInspection
Enables Pipeline Inspection. Pipeline Inspection is a consolidated pipeline view with metrics, opportunities, and highlights of recent changes.
PlatformCache
Enables Platform Cache and allocates a 3 MB cache. The Lightning Platform Cache layer provides faster performance and better reliability when caching Salesforce session and org data.
PlatformConnect:<value>
Enables Salesforce Connect and allows your users to view, search, and modify data that's stored outside your Salesforce org. Indicate a value from 1–5.
PlatformEncryption
Shield Platform Encryption encrypts data at rest. You can manage key material and encrypt fields, files, and other data.
PlatformEventsPerDay:<value>
Increases the maximum number of delivered standard-volume platform event notifications within a 24-hour period, shared by all CometD clients. Indicate a value between 10,000–50,000.
ProcessBuilder
Enables Process Builder, a Salesforce Flow tool that helps you automate your business processes.
ProductsAndSchedules
Enables product schedules in your scratch org. Enabling this feature lets you create default product schedules on products. Users can also create schedules for individual products on opportunities.
ProductCatalogManagementAddOn
Enables read-write access to Product Catalog Management features and objects.
ProductCatalogManagementViewerAddOn
Enables read access to Product Catalog Management features and objects.
ProductCatalogManagementPCAddOn
Enables read access to Product Catalog Management features and objects for Partner Community Users in scratch orgs.
ProgramManagement
Enables access to all Program Management and Case Management features and objects.
ProviderFreePlatformCache
Provides 3 MB of free Platform Cache capacity for security-reviewed managed packages. This feature is made available through a capacity type called Provider Free capacity and is automatically enabled in Developer Edition orgs. Allocate the Provider Free capacity to a Platform Cache partition and add it to your managed package.
ProviderManagement
Enables the objects, features, and permissions for managing provider networks, care plans, and service delivery in Public Sector Solutions.
PSSAssetManagement
Enables the objects, features, and permissions for managing assets in Public Sector Solutions.
PublicSectorAccess
Enables access to all Public Sector features and objects.
PublicSectorApplicationUsageCreditsAddOn
Enables additional usage of Public Sector applications based on their pricing.
PublicSectorSiteTemplate
Allows Public Sector users access to build an Experience Cloud site from the templates available.
RateManagement
Enables Rate Management that allows you to set, manage, and optimize rates for usage-based products.
RecordTypes
Enables Record Type functionality. Record Types let you offer different business processes, picklist values, and page layouts to different users.
RefreshOnInvalidSession
Enables automatic refreshes of Lightning pages when the user's session is invalid. If, however, the page detects a new token, it tries to set that token and continue without a refresh.
RevSubscriptionManagement
Enables Subscription Management. Subscription Management is an API-first, product-to-cash solution for B2B subscriptions and one-time sales.
S1ClientComponentCacheSize
Allows the org to have up to 5 pages of caching for Lightning Components.
SalesCloudEinstein
Enables Sales Cloud Einstein features and Salesforce Inbox. Sales Cloud Einstein brings AI to every step of the sales process.
SalesforceContentUser
Enables access to Salesforce content features.
SalesforceFeedbackManagementStarter
Provides a license to use the Salesforce Feedback Management - Starter features.
SalesforceHostedMCP
Enables hosted MCP servers on the scratch org. With this scratch org feature parameter, MCP clients can connect to available hosted MCP servers.
SalesforceIdentityForCommunities
Adds Salesforce Identity components, including login and self-registration, to Experience Builder. This feature is required for Aura components.
SalesforcePricing
Enables Salesforce Pricing, which allows you to set, manage, and optimize prices across your entire product portfolio
SalesUser
Provides a license for Sales Cloud features.
SAML20SingleLogout
Enables usage of SAML 2.0 single logout.
SCIMProtocol
Enables access support for the SCIM protocol base API.
ScvMultipartyAndConsult
Enables you to set up and test multiparty calls and consult calls for Service Cloud Voice with Partner Telephony.
SecurityEventEnabled
Enables access to security events in Event Monitoring.
SentimentInsightsFeature
Provides the license required to enable and use Sentiment Insights in a scratch org. Use Sentiment Insights to analyze the sentiment of your customers and get actionable insights to improve it.
ServiceCatalog
Enables Employee Service Catalog so you can create a catalog of products and services for your employees. It can also turn your employees' requests for these products and services into approved and documented orders.
ServiceCloud
Assigns the Service Cloud license to your scratch org, so you can choose how your customers can reach you, such as by email, phone, social media, online communities, chat, and text.
ServiceCloudVoicePartnerTelephony
Assigns the Service Cloud Voice with Partner Telephony add-on license to your scratch org, so you can set up a Service Cloud Voice contact center that integrates with supported telephony providers. Indicate a value from 1–50.
ServiceUser
Adds one Service Cloud User license, and allows access to Service Cloud features.
SessionIdInLogEnabled
Enables Apex debug logs to include session IDs. If disabled, session IDs are replaced with "SESSION_ID_REMOVED" in debug logs.
SFDOInsightsDataIntegrityUser
Provides a license to Salesforce.org Insights Platform Data Integrity managed package. You can then install the package in the scratch org.
SharedActivities
Allow users to relate multiple contacts to tasks and events.
Sites
Enables Salesforce Sites, which allows you to create public websites and applications that are directly integrated with your Salesforce org. Users aren’t required to log in with a username and password.
SocialCustomerService
Enables Social Customer Service, sets post defaults, and either activates the Starter Pack or signs into your Social Studio account.
StateAndCountryPicklist
Enables state and country/territory picklists. State and country/territory picklists let users select states and countries from predefined, standardized lists, instead of entering state, country, and territory data into text fields.
StreamingAPI
Enables Streaming API.
StreamingEventsPerDay:<value>
Increases the maximum number of delivered PushTopic event notifications within a 24-hour period, shared by all CometD clients (API version 36.0 and earlier). Indicate a value between 10,000–50,000.
SubPerStreamingChannel:<value>
Increases the maximum number of concurrent clients (subscribers) per generic streaming channel (API version 36.0 and earlier). Indicate a value between 20–4,000.
SubPerStreamingTopic:<value>
Increases the maximum number of concurrent clients (subscribers) per PushTopic streaming channel (API version 36.0 and earlier). Indicate a value between 20–4,000.
SurveyAdvancedFeatures
Enables a license for the features available with the Salesforce Feedback Management - Growth license.
SustainabilityCloud
Provides the permission set licenses and permission sets required to install and configure Sustainability Cloud. To enable or use CRM Analytics and CRM Analytics templates, include the DevelopmentWave scratch org feature.
SustainabilityApp
Provides the permission set licenses and permission sets required to configure Net Zero Cloud. To enable or use Tableau CRM and Tableau CRM templates, include the DevelopmentWave scratch org feature.
TalentRecruitmentManagement
Enables the objects, features, and permissions for managing the talent recruitment and hiring process in Public Sector Solutions.
TCRMforSustainability
Enables all permissions required to manage the Net Zero Analytics app by enabling Tableau CRM. You can create and share the analytics app for your users to bring your environmental accounting in line with your financial accounting.
TimelineConditionsLimit
Limits the number of timeline record display conditions per event type to 3.
TimelineEventLimit
Limits the number of event types displayed on a timeline to 5.
TimelineRecordTypeLimit
Limits the number of related object record types per event type to 3.
TimeSheetTemplateSettings
Time Sheet Templates let you configure settings to create time sheets automatically. For example, you can create a template that sets start and end dates. Assign templates to user profiles so that time sheets are created for the right users.
TransactionFinalizers
Enables you to implement and attach Apex Finalizers to Queueable Apex jobs.
UsageManagement
Enables Usage Management. Using Usage Management, you can setup, track, and manage the consumption of usage-based products.
WaveMaxCurrency
Increases the maximum number of supported currencies for CRM Analytics. Indicate a value between 1–5.
WavePlatform
Enables the Wave Platform license.
Workflow
Enables Workflow so you can automate standard internal procedures and processes.
WorkflowFlowActionFeature
Allows you to launch a flow from a workflow action.
WorkplaceCommandCenterUser
Enables access to Workplace Command Center features including access to objects such as Employee, Crisis, and EmployeeCrisisAssessment.
WorkThanksPref
Enables the give thanks feature in Chatter.
AccountInspection
Enables the Account Intelligence view. The Account Intelligence view is a consolidated dashboard showing account metrics, activities, and related opportunities and cases.
AccountingSubledgerGrowthEdition
Provides three permission sets that enable access to Accounting Subledger Growth features.
More Information
Requires that you also include the DataProcessingEngine scratch org feature in your scratch org definition file. Requires that you enable Data Pipelines. Requires configuration using the Setup menu in the scratch org. See Accounting Subledger in Salesforce Help.

AccountingSubledgerStarterEdition
Provides three permission sets that enable access to Accounting Subledger Starter features.
More Information
Requires that you also include the DataProcessingEngine scratch org feature in your scratch org definition file. Requires that you enable Data Pipelines. Requires configuration using the Setup menu in the scratch org. See Accounting Subledger in Salesforce Help.

AccountingSubledgerUser
Enables organization-wide access to Accounting Subledger Growth features when the package is installed.
More Information
Requires that you install the Accounting Subledger or Accounting Subledger for Industries managed package. If you install the Accounting Subledger package, also set up the Opportunity object. See Accounting Subledger Legacy Documentation in Salesforce Help.

AddCustomApps:<value>
Increases the maximum number of custom apps allowed in an org. Indicate a value from 1–30.
Supported Quantities
1–30, Multiplier: 1

AddCustomObjects:<value>
Increases the maximum number of custom objects allowed in the org. Indicate a value from 1–30.
Supported Quantities
1–30, Multiplier: 1

AddCustomRelationships:<value>
Increases the maximum number of custom relationships allowed on an object. Indicate a value from 1–10.
Supported Quantities
1–10, Multiplier: 5

AddCustomTabs:<value>
Increases the maximum number of custom tabs allowed in an org. Indicate a value from 1–30.
Supported Quantities
1–30, Multiplier: 1

AddDataComCRMRecordCredit:<value>
Increases record import credits assigned to a user in your scratch org. Indicate a value from 1–30.
Supported Quantities
1–30, Multiplier: 1

AddInsightsQueryLimit:<value>
Increases the size of your CRM Analytics query results. Indicate a value from 1–30 (multiplier is 10). Setting the quantity to 6 increases the query results to 60.
Supported Quantities
1–30, Multiplier: 10

AdditionalFieldHistory:<value>
Increases the number of fields you can track history for beyond the default, which is 20 fields. Indicate a value between 1–40.
Supported Quantities
1–40, Multiplier: 1

More Information
Previous name: AddHistoryFieldsPerEntity.

AdmissionsConnectUser
Enables the Admissions Connect components. Without this scratch org feature parameter, the custom Admissions Connect components render as blank.
Scratch Org Definition File
Add these options to your scratch org definition file:
{
  "orgName": "Omega - Dev Org",
  "edition": "Partner Developer",
  "hasSampleData": "true",
  "features": [
    "DevelopmentWave",
    "AdmissionsConnectUser",
    "Communities", 
    "OmniStudioDesigner",
    "OmniStudioRuntime"
  ],
  "settings": {
      "lightningExperienceSettings": {
          "enableS1DesktopEnabled": true
      },
      "chatterSettings": {
          "enableChatter": true
      },
      "languageSettings": {
          "enableTranslationWorkbench": true
      },
      "enhancedNotesSettings": {
          "enableEnhancedNotes": true
      },
      "pathAssistantSettings": {
          "pathAssistantEnabled": true
      },
      "securitySettings": {
          "enableAdminLoginAsAnyUser":true
      },
      "userEngagementSettings": {
          "enableOrchestrationInSandbox": true,
          "enableOrgUserAssistEnabled": true,
          "enableShowSalesforceUserAssist": false
      },
      "experienceBundleSettings": {
          "enableExperienceBundleMetadata": true
      },
      "communitiesSettings": {
          "enableNetworksEnabled": true,
          "enableOotbProfExtUserOpsEnable": true
      },
      "mobileSettings": {
          "enableS1EncryptedStoragePref2": false
      }
  }
}
More Information
Next, install the Admissions Connect package in the scratch org. For installation instructions, see Install Admissions Connect in Salesforce Help.

AdvisorLinkFeature
Enables the Student Success Hub components. Without this scratch org feature parameter, the custom Student Success Hub components render as blank.
Scratch Org Definition File
Add these options to your scratch org definition file:
{
  "edition": "Partner Developer",
  "features": [
    "Communities",
    "FeatureParameterLicensing",
    "AdvisorLinkFeature"
  ],
  "orgName": "SAL - Dev Workspace",
  "hasSampleData": "true",
  "settings": {
    "chatterSettings": {
      "enableChatter": true
    },
    "communitiesSettings": {
      "enableNetworksEnabled": true,
      "enableOotbProfExtUserOpsEnable": true
    },
    "enhancedNotesSettings": {
      "enableEnhancedNotes": true
    },
    "experienceBundleSettings": {
      "enableExperienceBundleMetadata": true
    },
    "lightningExperienceSettings": {
      "enableS1DesktopEnabled": true
    },
    "mobileSettings": {
      "enableS1EncryptedStoragePref2": false
    },
    "languageSettings": {
      "enableTranslationWorkbench": true
    },
    "securitySettings": {
      "enableAdminLoginAsAnyUser": true
    }
  }
}
More Information
Next, install the Student Success Hub package in the scratch org. For setup instructions, see Install Student Success Hub in Salesforce Help.

AdvisorLinkPathwaysFeature
Enables the Pathways components. Without this scratch org feature parameter, the custom Pathways components render as blank.
Scratch Org Definition File
Add these options to your scratch org definition file:
{
  "orgName": "Pathways - Dev Org",
  "edition": "Partner Developer",
  "features": [
    "Communities",
    "FeatureParameterLicensing",
    "AdvisorLinkFeature",
    "AdvisorLinkPathwaysFeature"
  ],
  "settings": {
    "chatterSettings": {
      "enableChatter": true
    },
    "enhancedNotesSettings": {
      "enableEnhancedNotes": true
    },
    "communitiesSettings": {
      "enableNetworksEnabled": true
    },
    "languageSettings": {
      "enableTranslationWorkbench": true
    },
    "lightningExperienceSettings": {
      "enableS1DesktopEnabled": true
    },
    "mobileSettings": {
      "enableS1EncryptedStoragePref2": false
    }
  }
}
More Information
Next, install the Pathways package in the scratch org. For setup instructions, see Set Up Pathways in Salesforce Help.

AIAttribution
Provides access to Einstein Attribution for Marketing Cloud Account Engagement. Einstein Attribution uses AI modeling to dynamically assign attribution percentages to multiple campaign touchpoints.
Sample Scratch Org Definition File
Before enabling Einstein Attribution, make sure that enableAIAttribution and enableCampaignInfluence2 are set to true.

{
  "orgName": "NTOutfitters",
  "edition": "Enterprise",
  "features": ["AIAttribution"],
  "settings": {
    "campaignSettings": {
        "enableAIAttribution": true
        "enableCampaignInfluence2": true

    }
}
More Information
This feature is available in Account Engagement Advanced and Premium editions.

Optional configuration steps are accessible in Setup in the scratch org. For more information, see Salesforce Help: Einstein Attribution.

AllUserIdServiceAccess
Enables all users to access all users’ information via the user ID service.
More Information
The AllUserIdServiceAccess permission is off by default for all new and existing orgs. To turn on this feature, contact Salesforce Customer Support.

AnalyticsAdminPerms
Enables all permissions required to administer the CRM Analytics platform, including permissions to enable creating CRM Analytics templated apps and CRM Analytics Apps.
More Information
See Set Up the CRM Analytics Platform in Salesforce Help for more information.

AnalyticsAppEmbedded
Provides one CRM Analytics Embedded App license for the CRM Analytics platform.
ApexGuruCodeAnalyzer
Enables ApexGuru's generative AI-powered runtime insights in Salesforce Code Analyzer, which delivers Apex code quality recommendations directly in developer IDEs.
More Information
To improve developer accuracy and speed, use ApexGuru in Salesforce Code Analyzer to detect antipatterns using both static analysis and generative AI.

For more information about ApexGuru, see ApexGuru Insights in Salesforce Help.

API
Even in the editions (Professional, Group) that don’t provide API access, REST API is enabled by default. Use this scratch org feature to access additional APIs (SOAP, Streaming, Bulk, Bulk 2.0).
More Information
See Salesforce editions with API access for more information.

ArcGraphCommunity
Lets you add Actionable Relationship Center (ARC) components to Experience Cloud pages so your users can view ARC Relationship Graphs.
More Information
Provides 1 seat of the FinancialServicesEALoginAddon add-on license.

Requires that you install Financial Services Cloud. See Customize Experience Cloud Templates using ARC Components in Financial Services Cloud Administrator Guide.

Assessments
Enables dynamic Assessments features, which enables both Assessment Questions and Assessment Question Sets.
More Information
Add these options to your scratch org feature definition file. For "edition," you can indicate any of the supported scratch org feature editions.

{
  "orgName": "Sample Org",
  "edition": "Developer",
  "features": ["Assessments"],
  "settings": {
    "industriesSettings": {
      "enableIndustriesAssessment": true,
      "enableDiscoveryFrameworkMetadata": true
    }
  }
}
Add the Assessment to the page layout. See Page Layouts in Salesforce Help for more information.

AssetScheduling:<value>
Enables Asset Scheduling license. Asset Scheduling makes it easier to book rooms and equipments. Indicate a value between 1–10.
Supported Quantities
1–10

More Information
See Enable Asset Scheduling in Salesforce Scheduler in Salesforce Help for more information.

AssociationEngine
Enables the Association Engine, which automatically associates new accounts with the user’s current branch by creating branch unit customer records.
More Information
Provides 11 seats of the FSCComprehensivePsl user license and 11 seats of the FSCComprehensiveAddOn add-on license.

Requires that you install Financial Services Cloud. See AssociationEngineSettings in Metadata API Developer Guide.

AuthorApex
Enables you to access and modify Apex code in a scratch org. Enabled by default in Enterprise and Developer Editions.
More Information
For Group and Professional Edition orgs, this feature is disabled by default. Enabling the AuthorApex feature lets you edit and test your Apex classes.

B2BCommerce
Provides the B2B License. B2BCommerce enables business-to-business (B2B) commerce in your org. Create and update B2B stores. Create and manage buyer accounts. Sell products to other businesses.
More Information
Requires that you also include the Communities scratch org feature in your scratch org definition file to create a store using B2B Commerce. Not available in Professional, Partner Professional, Group, or Partner Group Edition orgs.

B2BLoyaltyManagement
Enables the B2B Loyalty Management license. Create loyalty programs and set up loyalty program-specific processes that allow you to recognize, rewards, and retain customers.
More Information
See Loyalty Management in Salesforce Help for more information.

B2CCommerceGMV
Provides the B2B2C Commerce License. B2B2C Commerce allows you to quickly stand up an ecommerce site to promote brands and sell products into multiple digital channels. You can create and update retail storefronts in your org, and create and manage person accounts.
More Information
Also requires the Communities feature in your scratch org definition file.

Not available in Professional, Partner Professional, Group, or Partner Group Edition orgs.

For more information, see Salesforce Help at Salesforce B2B Commerce and B2B2C Commerce..

B2CLoyaltyManagement
Enables the Loyalty Management - Growth license. Create loyalty programs and set up loyalty program-specific processes that allow you to recognize, rewards, and retain customers.
More Information
See Loyalty Management in Salesforce Help for more information.

B2CLoyaltyManagementPlus
Enables the Loyalty Management - Advanced license. Create loyalty programs and set up loyalty program-specific processes that allow you to recognize, rewards, and retain customers.
More Information
See Loyalty Management in Salesforce Help for more information.

BatchManagement
Enables the Batch Management license. Batch Management allows you to process a high volume of records in manageable batches.
More Information
See Batch Management in Salesforce Help for more information.

BenefitManagement
Enables the objects, features, and permissions for managing benefits programs, benefit disbursements, and benefit applicant tracking in Public Sector Solutions.
Sample Scratch Org Definition File
To enable BenefitManagement, add these features and settings to your scratch org definition file.

{
    "orgName": "BM Org",
    "edition": "Developer",
    "features": ["BenefitManagement:2"],
    "settings": {
    "lightningExperienceSettings": {
    "enableS1DesktopEnabled": true
    },
    "mobileSettings": {
    "enableS1EncryptedStoragePref2": false
    },
    "IndustriesSettings": {
    "enableIndustriesAssessment": true,
    "enableDiscoveryFrameworkMetadata": true,
    "enableInteractionSummaryPref": true,
    "enableBenefitManagementPreference": true,
    "enableGroupMembershipPref": true,
    "enableCaseReferralPref": true
    },
    "OmniStudioSettings": {
    "enableOmniStudioMetadata": false
    },
    "DocumentChecklistSettings": {
    "deleteDCIWithFiles": true
    }
    }
    }
BigObjectsBulkAPI
Enables the scratch org to use BigObjects in the Bulk API.
More Information
See Big Objects Implementation Guide for more information.

BillingAdvanced
Enables access to all the Billing features and objects that are available with the Revenue Cloud Billing license in the scratch org.
More Information
Available in Enterprise, Unlimited, and Developer Edition scratch orgs.
Provides 10 seats of BillingAdvancedAddOn add-on licenses.
Enable Billing in Revenue Cloud and turn on Billing settings.
Provides permission sets to access Billing features.
See Manage Billing in Revenue Cloud for more information.
Scratch Org Definition File
To enable BillingAdvanced, add these settings to your scratch org definition file.

{
  "orgName": "<Org Name>",
  "adminEmail":"<Admin Email Address>"
  "edition": "<Edition Name>",
  "features": [
    "InvoiceManagement",
    "BillingAdvanced",
    "EnableSetPasswordInApi"
  ],
  "settings": {
    "billingSettings": {
      "enableBillingSetup": true
    },
   "lightningExperienceSettings": {
        "enableS1DesktopEnabled": true
      }
  }
}
Briefcase
Enables the use of Briefcase Builder in a scratch org, which allows you to create offline briefcases that make selected records available for viewing offline.
BudgetManagement
Gives users access to budget management features and objects. To enable budget management, add this feature to your scratch org definition file.
More Information
See Budget Management in Salesforce Help for more information.

BusinessRulesEngine
Enables Business Rules Engine, which enables both expression sets and lookup tables.
More Information
Provides 10 Business Rules Engine Designer and 10 Business Rules Engine Runtime licenses. For more information, see Business Rules Engine in Salesforce Help.

BYOCCaaS
Enables you to set up and test a partner contact center that integrates with supported Contact Center as a Service (CCaaS) providers in your scratch org.
More Information
This feature requires that you also include the ServiceCloud and Scrt2Conversation scratch org features in your scratch org definition file. You must also enable second-generation managed packaging to use this feature in a scratch org. Available in Salesforce Enterprise and Developer Editions.

For setup and configuration steps, see Bring Your Own Channel for CCaaS in Salesforce Help.

Sample Scratch Org Definition File
{
  "orgName": "BYO CCaaS Scratch Org",
  "edition": "Developer",
  "features": ["ServiceCloud", "Scrt2Conversation", "BYOCCaaS"
  "settings": {
    "lightningExperienceSettings": {
      "enableS1DesktopEnabled": true
     },
   "mobileSettings": {
      "enableS1EncryptedStoragePref2": false
    }
  }
}
BYOOTT
Enables you to set up and test a Bring Your Own Channel for Messaging channel that integrates with supported Messaging providers in your scratch org.
More Information
This feature requires that you also include the ServiceCloud and Scrt2Conversation scratch org features in your scratch org definition file. You must also enable second-generation managed packaging to use this feature in a scratch org. Available in Salesforce Enterprise and Developer Editions.

For setup and configuration steps, see Bring Your Own Channel in Salesforce Help.

Sample Scratch Org Definition File
{
  "orgName": "BYOC Scratch Org",
  "edition": "Developer",
  "features": ["ServiceCloud", "Scrt2Conversation", "BYOOTT"
  "settings": {
    "lightningExperienceSettings": {
      "enableS1DesktopEnabled": true
     },
   "mobileSettings": {
      "enableS1EncryptedStoragePref2": false
    }
  }
}
CacheOnlyKeys
Enables the cache-only keys service. This feature allows you to store your key material outside of Salesforce, and have the Cache-Only Key Service fetch your key on demand from a key service that you control.
More Information
Requires enabling PlatformEncryption and configuration using the Setup menu in the scratch org. See Which User Permissions Does Shield Platform Encryption Require?, Generate a Tenant Secret with Salesforce, and Cache-Only Key Service in Salesforce Help.

CalloutSizeMB:<value>
Increases the maximum size of an Apex callout. Indicate a value between 3–12.
Supported Quantities
3–12, Multiplier: 1

CampaignInfluence2
Provides access to Customizable Campaign Influence for Sales Cloud and Marketing Cloud Account Engagement. Customizable Campaign Influence can auto-associate or allow manual creation of relationships among campaigns and opportunities to track attribution.
Sample Scratch Org Definition File
To enable Customizable Campaign Influence, set enableCampaignInfluence2 to true.

{
  "orgName": "NTOutfitters",
  "edition": "Enterprise",
  "features": ["CampaignInfluence2"],
  "settings": {
    "campaignSettings": {
        "enableCampaignInfluence2": true

    }
}
More Information
This feature is available in Salesforce Enterprise, Performance, Unlimited, and Developer Editions.

Optional configuration steps are accessible in Setup in the scratch org. For more information, see Salesforce Help: Customizable Campaign Influence.

CascadeDelete
Provides lookup relationships with the same cascading delete functionality previously only available to master-detail relationships. To prevent records from being accidentally deleted, cascade-delete is disabled by default.
CaseClassification
Enables Einstein Case Classification. Case Classification offers recommendations to your agents so they can select the best value. You can also automatically save the best recommendation and route the case to the right agent.
CaseWrapUp
Enables Einstein Case Wrap-Up. To help agents complete cases quickly, Einstein Case Wrap-Up recommends case field values based on past chat transcripts.
More Information
Available in Enterprise Edition scratch orgs.

Requires configuration using the Setup menu in the scratch org.

See Set Up Einstein Classification Apps in Salesforce Help for more information.

CGAnalytics
Enables the Consumer Goods Analytics org perm in scratch orgs.
More Information
Provides 1 seat of the CGAnalyticsPlus add-on license.

ChangeDataCapture
Enables Change Data Capture, if the scratch org edition doesn't automatically enable it.
Chatbot
Enables deployment of Bot metadata into a scratch org, and allows you to create and edit bots.
More Information
To use this feature, turn on Enable Einstein Features in the Dev Hub org to accept the Terms of Service.

See Einstein Bots in Salesforce Help for more information.

ChatterEmailFooterLogo
ChatterEmailFooterLogo allows you to use the Document ID of a logo image, which you can use to customize chatter emails.
More Information
See Add Your Custom Brand to Email Notifications in Salesforce Help for more information.

ChatterEmailFooterText
ChatterEmailFooterText allows you to use footer text in customized Chatter emails.
More Information
See Add Your Custom Brand to Email Notifications in Salesforce Help for more information.

ChatterEmailSenderName
ChatterEmailSenderName allows you to customize the name that appears as the sender’s name in the email notification. For example, your company’s name.
More Information
See Chatter Email Settings and Branding in Salesforce Help for more information.

CloneApplication
CloneApplication allows you to clone an existing custom Lightning app and make required customizations to the new app. This way, you don’t have to start from scratch, especially when you want to create apps with simple variations.
More Information
See Create Lightning Apps in Salesforce Help for more information.

CMSMaxContType
Limits the number of distinct content types you can create within Salesforce CMS to 21.
CMSMaxNodesPerContType
Limits the maximum number of child nodes (fields) you can create for a particular content type to 15.
CMSUnlimitedUse
Enables unlimited content records, content types, and bandwidth usage in Salesforce CMS.
Communities
Allows the org to create an Experience Cloud site. Experience Cloud uses the term Communities in its configuration. To use Communities, you must also include communitiesSettings > enableNetworksEnabled in the settings section of your scratch org definition file.
More Information
Available in Enterprise and Developer Edition scratch orgs.

CompareReportsOrgPerm
Enables the org permission to allow for comparison of Lightning Reports.
ConAppPluginExecuteAsUser
Enables the pluginExecutionUser field in the ConnectedApp Metadata API object.
ConcStreamingClients:<value>
Increases the maximum number of concurrent clients (subscribers) across all channels and for all event types for API version 36.0 and earlier. Indicate a value between 20–4,000.
Supported Quantities
20–4,000, Multiplier: 1

ConnectedAppCustomNotifSubscription
Enables connected apps to subscribe to custom notification types, which are used to send custom desktop and mobile notifications.
More Information
Sending custom notifications requires both CustomNotificationType to create notification types and ConnectedAppCustomNotifSubscription to subscribe to notification types. See Manage Your Notifications with Notification Builder in Salesforce Help for more information on custom notifications.

ConnectedAppToolingAPI
Enables the use of connected apps with the Tooling API.
ConsentEventStream
Enables the Consent Event Stream permission for the org.
More Information
See Use the Consent Event Stream in Salesforce Help for more information.

ConsolePersistenceInterval:<value>
Increases how often console data is saved, in minutes. Indicate a value between 0–500. To disable auto save, set the value to 0.
Supported Quantities
0–500, Multiplier: 1

ContactsToMultipleAccounts
Enables the contacts to multiple accounts feature. This feature lets you relate a contact to two or more accounts.
ContractApprovals
Enables contract approvals, which allow you to track contracts through an approval process.
ContractManagement
Enables the Contract Lifecycle (CLM) Management features in the org.
ContractMgmtInd
Enables the Contract Lifecycle Management (CLM) features for Industries.
CoreCpq
Enables read-write access to Revenue Cloud features and objects. To use Revenue Cloud, you must also include revenueManagementSettings > enableCoreCPQ in the settings section of your scratch org definition file.
More Information
Available in Developer and Enterprise scratch org editions.
Provides 10 RevenueLifecycleManagementAddOn add-on licenses.
Provides permission sets for Context Service, Business Rules Engine, Document Generation, Omnistudio, Data Processing Engine, Product Catalog Management, Salesforce Pricing, Product Configurator, Transaction Management, Salesforce Contracts, Rate Management, Dynamic Revenue Orchestrator, and Billing.
Displays the setup pages for Context Service, Business Rules Engine, Document Generation, Omnistudio, Data Processing Engine, Product Catalog Management, Salesforce Pricing, Revenue Settings (Product Configurator and Transaction Management), Contracts, Rate Management, Dynamic Revenue Orchestrator, and Billing.
Requires configuration using the Setup menu in the scratch org. See Revenue Cloud.
Scratch Org Definition File
Add these options to your scratch org definition file.

{
"edition": "Enterprise",
"features": [
"BusinessRulesEngine",
"Communities",
"OrderSaveLogicEnabled",
"OrderManagement",
"OrderSaveBehaviorBoth",
"PartnerCommunity",
“CustomerCommunityPlus",
"ContextService",
"CoreCpq",
"SalesforcePricing",
"SalesforceConfiguratorEngine",
"UsageManagement",
"BillingAdvanced",
"DocGen",
"EnableSetPasswordInApi",
"ProductCatalogManagementPCAddOn"
],
"settings": {
"communitiesSettings": {
"enableNetworksEnabled": true
},
"customAddressFieldSettings": {
"enableCustomAddressField": true
},
"currencySettings": {
"enableMultiCurrency": true
},
"experienceBundleSettings": {
"enableExperienceBundleMetadata": true
},
"lightningExperienceSettings": {
"enableS1DesktopEnabled": true
},
"industriesContextSettings": {
"enableContextDefinitions": true
},
"opportunitySettings": {
"enableOpportunityTeam": true
},
"revenueManagementSettings": {
"enableCoreCPQ": true
},
"orderManagementSettings": {
"enableOrderManagement": true
},
"orderSettings": {
"enableOrders": true,
"enableEnhancedCommerceOrders": true,
"enableOrderEvents": true,
"enableOptionalPricebook": true,
"enableZeroQuantity": true,
"enableNegativeQuantity": true
},
"quoteSettings": {
"enableQuote": true,
"enableQuotesWithoutOppEnabled": true
},
"industriesPricingSettings": {
"enableSalesforcePricing": true
},
"industriesRatingSettings": {
"enableRating": true,
"enableRatingWaterfall": true,
"enableRatingWaterfallPersistence": true
},
"DynamicFulfillmentOrchestratorSettings": {
"enableDFOPref": true
}
},
  "orgName": "<your org name>",
  "adminEmail": "<your admin email>"
}
CPQ
Enables the licensed features required to install the Salesforce CPQ managed package but doesn't install the package automatically.
More Information
For additional information and configuration steps, see Manage Your Quotes with CPQ in Salesforce Help.

CustomerDataPlatform
Enables the CustomerDataPlatform license in scratch orgs.
Sample Scratch Org Definition File
{
  "orgName": "Acme",
  "edition": "Developer",
  "features": ["CustomerDataPlatform", "CustomerDataPlatformLite"],
  "settings": {
    "customerDataPlatformSettings" : {
      "enableCustomerDataPlatform" : true 
    }
  }
}
More Information
To create scratch orgs that use Data Cloud, you must first log a case with Salesforce Partner Support. This feature can be enabled on your Partner Business Org (PBO) only. After it’s enabled, you can create scratch orgs with Data Cloud features. .

See Salesforce Help: Feature Availability in Data Cloud and Customer Data Platform for a list of functionality available with the CustomerDataPlatform license.

CustomerDataPlatformLite
Enables the Data Cloud license in scratch orgs. You must also include the CustomerDataPlatform feature and enableCustomerDataPlatform Metadata API setting in your scratch org definition.
Sample Scratch Org Definition File
{
  "orgName": "Acme",
  "edition": "Developer",
  "features": ["CustomerDataPlatform", "CustomerDataPlatformLite"],
  "settings": {
    "customerDataPlatformSettings" : {
      "enableCustomerDataPlatform" : true 
    }
  }
}
More Information
To create scratch orgs that use Data Cloud, you must first log a case with Salesforce Partner Support. This feature can be enabled on your Partner Business Org (PBO) only. After it’s enabled, you can create scratch orgs with Data Cloud features.

See Salesforce Help: Feature Availability in Data Cloud and Customer Data Platform for a list of functionality available with the Data Cloud license.

CustomerExperienceAnalytics
Enables the Customer Lifecycle Analytics org perm in scratch orgs.
More Information
Provides 1 seat of the CustomerExperienceAnalyticsPlus add-on license.

CustomFieldDataTranslation
Enables translation of custom field data for Work Type Group, Service Territory, and Service Resource objects. You can enable data translation for custom fields with Text, Text Area, Text Area (Long), Text Area (Rich), and URL types.
More Information
Requires that you also include the EntityTranslation scratch org feature in your scratch org definition file. Not available in Professional, Partner Professional, Group, or Partner Group Edition orgs.

CustomNotificationType
Allows the org to create custom notification types, which are used to send custom desktop and mobile notifications.
More Information
Sending custom notifications requires both CustomNotificationType to create notification types and ConnectedAppCustomNotifSubscription to subscribe to notification types. See Manage Your Notifications with Notification Builder in Salesforce Help for more information on custom notifications.

DataComDnbAccounts
Provides a license to Data.com account features.
DataComFullClean
Provides a license to Data.com cleaning features, and allows users to turn on auto fill clean settings for jobs.
DataMaskUser
Provides 30 Data Mask permission set licenses. This permission set enables access to an installed Salesforce Data Mask package.
More Information
For additional installation and configuration steps, see Install the Managed Package in Salesforce Help.

DataProcessingEngine
Enables the Data Processing Engine license. Data Processing Engine helps transform data that's available in your Salesforce org and write back the transformation results as new or updated records.
More Information
See Data Processing Engine in Salesforce Help for more information.

DebugApex
Enables Apex Interactive Debugger. You can use it to debug Apex code by setting breakpoints and checkpoints, and inspecting your code to find bugs.
DecisionTable
Enables Decision Table license. Decision tables read business rules and decide the outcome for records in your Salesforce org or for the values that you specify.
More Information
See Decision Table in Salesforce Help for more information.

DefaultWorkflowUser
Sets the scratch org admin as the default workflow user.
DeferSharingCalc
Allows admins to suspend group membership and sharing rule calculations and to resume them later.
More Information
Requires configuration using the Setup menu in the scratch org. See Defer Sharing Calculations in Salesforce Help.

DevelopmentWave
Enables CRM Analytics development in a scratch org. It assigns five platform licenses and five CRM Analytics platform licenses to the org, along with assigning the permission set license to the admin user. It also enables the CRM Analytics Templates and Einstein Discovery features.
DeviceTrackingEnabled
Enables Device Tracking.
DevOpsCenter
Enables DevOps Center in scratch orgs so that partners can create second-generation managed packages that extend or enhance the functionality in the DevOps Center application (base) package.
Dev Hub Org
Ask a Salesforce admin to enable DevOps Center in the Dev Hub org. From Setup, enter DevOps Center in the Quick Find box, then select DevOps Center. You can create scratch orgs after the org preference is enabled.

Scratch Org Definition File
Add these options to your scratch org definition file:

{
    "orgName": "Acme",
    "edition": "Enterprise",
    "features": ["DevOpsCenter"],
    "settings": {
        "devHubSettings": {
            "enableDevOpsCenterGA": true
            }  
        }  
    }
Scratch Org Definition File For Scratch Orgs Created from an Org Shape
If you create a scratch org based on an org shape with DevOps Center enabled, we still require that you add the DevOps Center feature and setting to the scratch org definition for legal reasons as part of the DevOps Center terms and conditions.

{
    "orgName": "Acme",
    "sourceOrg": "00DB1230400Ifx5",
    "features": ["DevOpsCenter"],
    "settings": {
        "devHubSettings": {
            "enableDevOpsCenterGA": true
            }  
        }  
    }
More Information
Salesforce Help: Build an Extension Package for DevOps Center

DisableManageIdConfAPI
Limits access to the LoginIP and ClientBrowser API objects to allow view or delete only.
DisclosureFramework
Provides the permission set licenses and permission sets required to configure Disclosure and Compliance Hub.
Scratch Org Definition File
Add these options to your scratch org definition file:

{
  "orgName": "dch org",
  "edition": "Developer",
  "features": ["DisclosureFramework"],
  "settings": {
    "industriesSettings":{
      "enableGnrcDisclsFrmwrk": true,
      "enableIndustriesAssessment" : true
    }
  }
}
More Information
For configuration steps, see Disclosure and Compliance Hub in the Set Up and Maintain Net Zero Cloud guide in Salesforce Help.

Division
Turns on the Manage Divisions feature under Company Settings. Divisions let you segment your organization's data into logical sections, making searches, reports, and list views more meaningful to users. Divisions are useful for organizations with extremely large amounts of data.
DocGen
Enables the Document Generation Feature in the Org.
DocGenDesigner
Enables the designers to create and configure document templates.
DocGenInd
Enables the Industry Document Generation features in the org.
DocumentChecklist
Enables Document Tracking and Approval features, and adds the Document Checklist permission set. Document tracking features let you define documents to upload and approve, which supports processes like loan applications or action plans.
More Information
See Enable Document Tracking and Approvals in the Financial Services Cloud Administrator Guide for more information.

DocumentReaderPageLimit
Limits the number of pages sent for data extraction to 5.
More Information
See Intelligent Form Reader in Salesforce Help for more information.

DSARPortability
Enables an org to access the DSARPortability feature in Privacy Center. Also, provides one seat each of the PrivacyCenter and PrivacyCenterAddOn licenses.
More Information
See Portability in the Salesforce REST API Developer Guide for more information.

DurableClassicStreamingAPI
Enables Durable PushTopic Streaming API for API version 37.0 and later.
More Information
Available in Enterprise and Developer Edition scratch orgs.

DurableGenericStreamingAPI
Enables Durable Generic Streaming API for API version 37.0 and later.
More Information
Available in Enterprise and Developer Edition scratch orgs.

DynamicClientCreationLimit
Allows the org to register up to 100 OAuth 2.0 connected apps through the dynamic client registration endpoint.
EAndUDigitalSales
Enables the Energy and Utilities Digital Sales feature in the org.
EAndUSelfServicePortal
Enables the Self Service Portal features for Digital Experience users in the org.
EAOutputConnectors
Enable CRM Analytics Output Connectors.
More Information
This scratch org requires the Dev Hub to have the EAOutputConnectors permission. See Salesforce Output Connection in Salesforce Help for more details.

EASyncOut
Enable CRM Analytics SyncOut.
More Information
This scratch org requires the Dev Hub to have the EASyncOut permission. See Sync Out for Snowflake in Salesforce Help for more details.

EdPredictionM3Threshold
Sets the number of records in the payload to 10, after which the Einstein Discovery prediction service uses M3.
EdPredictionTimeout
Sets the maximum duration of a single Einstein Discovery prediction to 100 milliseconds.
EdPredictionTimeoutBulk
Sets the maximum duration of a single Einstein Discovery prediction when it runs in bulk to 10 milliseconds.
EdPredictionTimeoutByomBulk
Sets the maximum duration of a single Bring Your Own Model (BYOM) Einstein Discovery prediction to 100 milliseconds.
EducationCloud: <value>
Enables use of Education Cloud.
Supported Quantities
Maximum: 10; Multiplier: 1

More Information
Standard set up steps are required after enabling this feature. See Set Up Education Cloud in Salesforce Help for more information.

Einstein1AIPlatform
Provides access to Einstein generative AI features such as Agentforce, Prompt Builder, Model Builder, and the Models API. To use generative AI features, you must also include einsteinGptSettings > enableEinsteinGptPlatform in the settings section of your scratch org definition file.
Scratch Org Definition File
Add these options to your scratch org definition file:

{
  "orgName": "Agentforce scratch org",
  "edition": "Developer",
  "features": ["Einstein1AIPlatform"],
  "settings": {
      "einsteinGptSettings": {
          "enableEinsteinGptPlatform": true
      }
   }
}
Additional Configuration for Prompt Builder
After you generate the scratch org, Prompt Builder isn’t available until you assign yourself the Manage Prompts permission in the scratch org.

When packaging a prompt template in second-generation packages, add the EinsteinGPTPromptTemplateManager permission set to the sfdx-project.json file. See Considerations for Packaging Prompt Templates in Salesforce Help for details.

More Information
Available in Developer and Enterprise Edition scratch orgs.

Requires configuration using the Setup menu in the scratch org. Many generative AI features also require a Data Cloud license.

See Einstein Generative AI in Salesforce Help for more information.

EinsteinAnalyticsPlus
Provides one CRM Analytics Plus license for the CRM Analytics platform.
EinsteinArticleRecommendations
Provides licenses for Einstein Article Recommendations. Einstein Article Recommendations uses data from past cases to identify Knowledge articles that are most likely to help your customer service agents address customer inquiries.
More Information
Available in Enterprise Edition scratch orgs.

Requires configuration using the Setup menu in the scratch org.

See Set Up Einstein Article Recommendations in Salesforce Help for more information.

EinsteinBuilderFree
Provides a license that allows admins to create one enabled prediction with Einstein Prediction Builder. Einstein Prediction Builder is custom AI for admins
More Information
For configuration steps, see Einstein Prediction Builder in Salesforce Help.

EinsteinDocReader
Provides the license required to enable and use Intelligent Form Reader in a scratch org. Intelligent Form Reader uses optical character recognition to automatically extract data with Amazon Textract.
More Information
To use this scratch org feature, the Dev Hub org requires the EinsteinDocReader and SalesforceManagedIFR permissions. For information about Intelligent Form Reader, see Intelligent Form Reader in Salesforce Help.

EinsteinRecommendationBuilder
Provides a license to create recommendations with Einstein Recommendation Builder. Einstein Recommendation Builder lets you build custom AI recommendations.
More Information
Enabled in Developer and Enterprise Editions.

Requires configuration using the Setup menu in the scratch org. You also need the EinsteinRecommendationBuilderMetadata feature to use Einstein Recommendation Builder in scratch org.

EinsteinSearch
Provides the license required to use and enable Einstein Search features in a scratch org.
More Information
Available in Professional and Enterprise Edition scratch orgs.

Requires configuration using the Setup menu in the scratch org.

EinsteinVisits
Enables Consumer Goods Cloud. With Consumer Goods cloud, transform the way you collaborate with your retail channel partners. Empower your sales managers to plan visits and analyze your business’s health across stores. Also, allow your field reps to track inventory, take orders, and capture visit details using the Retail Execution mobile app.
EinsteinVisitsED
Enables Einstein Discovery, which can be used to get store visit recommendations. With Einstein Visits ED, you can create a visit frequency strategy that allows Einstein to provide optimal store visit recommendations.
More Information
See Create a Visit Frequency Next Best Action Strategy in Salesforce Help.

EmbeddedLoginForIE
Provides JavaScript files that support Embedded Login in IE11.
EmpPublishRateLimit:<value>
Increases the maximum number of standard-volume platform event notifications published per hour. Indicate a value between 1,000–10,000.
Supported Quantities
1,000–10,000, Multiplier: 1

EnablePRM
Enables the partner relationship management permissions for the org.
EnableManageIdConfUI
Enables access to the LoginIP and ClientBrowser API objects to verify a user's identity in the UI.
Enablement
Enables features for creating, taking, and tracking sales programs with Enablement. Business operations experts and sales leaders identify the revenue outcomes they want sales reps to achieve, such as increased average deal sizes or shorter ramp times. Then, they create programs that help sales reps work towards those outcomes as part of their daily work.
More Information
Provides 5 Enablement add-on licenses, where each license provides 1 seat of the Enablement permission set license and 1 seat of the Enablement Resources permission set license.
Provides permission set groups, permission sets, and user permissions for managing and accessing sales programs data.
Provides access to the Enablement Settings page in Setup, which provides guidance for assigning permissions and includes other optional configuration settings.
See Sales Programs and Partner Tracks with Enablement in Salesforce Help and see the Sales Programs and Partner Tracks with Enablement Developer Guide for more information.

EnableSetPasswordInApi
Enables you to use sf org generate password to change a password without providing the old password.
EncryptionStatisticsInterval:<value>
Defines the interval (in seconds) between encryption statistics gathering processes. The maximum value is 604,800 seconds (7 days). The default is once per 86,400 seconds (24 hours).
Supported Quantities
0–60,4800, Multiplier: 1

More Information
Requires enabling PlatformEncryption and some configuration using the Setup menu in the scratch org. See Which User Permissions Does Shield Platform Encryption Require?, and Generate a Tenant Secret with Salesforce in Salesforce Help.

EncryptionSyncInterval:<value>
Defines how frequently (in seconds) the org can synchronize data with the active key material. The default and maximum value is 604,800 seconds (7 days). To synchronize data more frequently, indicate a value, in seconds, equal to or larger than 0.
Supported Quantities
0–604,800, Multiplier: 1

More Information
Requires enabling PlatformEncryption and some configuration using the Setup menu in the scratch org. See Which User Permissions Does Shield Platform Encryption Require?, and Generate a Tenant Secret with Salesforce in Salesforce Help.

EnergyAndUtilitiesCloud
Enables the Energy and Utilities Cloud features in the org.
Entitlements
Enables entitlements. Entitlements are units of customer support in Salesforce, such as phone support or web support that represent terms in service agreements.
ERMAnalytics
Enables the ERM Analytics org perm in your scratch org.
More Information
Provides 1 seat of the ERMAnalyticsPlus add-on license.

EventLogFile
Enables API access to your org's event log files. The event log files contain information about your org’s operational events that you can use to analyze usage trends and user behavior.
EntityTranslation
Enables translation of field data for Work Type Group, Service Territory, and Service Resource objects.
More Information
To translate custom field data, also include the CustomFieldDataTranslation scratch org feature in your scratch org definition file. Not available in Professional, Partner Professional, Group, or Partner Group Edition orgs.

ExcludeSAMLSessionIndex
Excludes Session Index in SAML sign-on (SSO) and single logout (SLO) flows.
More Information
The ExcludeSAMLSessionIndex permission is off by default for all new and existing orgs. Enable this permission when Salesforce is the identity provider and you don’t want the session index to be sent during SAML SSO. Enable this permission when Salesforce is the service provider and you don’t want the session index to be sent during SLO. To turn on this feature, contact Salesforce Customer Support.

Explainability
Enables an org to use Decision Explainer features.
For more information, see Decision Explainer for Expression Set in Salesforce developer documentation.

ExpressionSetMaxExecPerHour
Enables an org to run a maximum of 500,000 expression sets per hour by using Connect REST API.
For more information, see Expression Set in Salesforce developer documentation.

ExternalIdentityLogin
Allows the scratch org to use Salesforce Customer Identity features associated with your External Identity license.
FieldAuditTrail
Enables Field Audit Trail for the org and allows a total 60 tracked fields. By default, 20 fields are tracked for all orgs, and 40 more are tracked with Field Audit Trail.
More Information
Previous name: RetainFieldHistory

FieldService:<value>
Provides the Field Service license. Indicate a value between 1–25.
Supported Quantities
1–25, Multiplier: 1

More Information
Available in Enterprise Edition. Enabled by default in Developer Edition. See Enable Field Service in Salesforce Help for more information.

FieldServiceAppointmentAssistantUser:<value>
Adds the Field Service Appointment Assistant permission set license. Indicate a value between 1–25.
Supported Quantities
1–25, Multiplier: 1

More Information
See Setup Field Service Appointment Assistant and Assign Field Service Permissions in Salesforce Help for more information.

FieldServiceDispatcherUser:<value>
Adds the Field Service Dispatcher permission set license. Indicate a value between 1–25.
Supported Quantities
1–25, Multiplier: 1

More Information
See Assign Field Service Permissions in Salesforce Help for more information.

FieldServiceLastMileUser:<value>
Adds the Field Service Last Mile permission set license. Indicate a value between 1–25.
Supported Quantities
1–25, Multiplier: 1

FieldServiceMobileExtension
Adds the Field Service Mobile Extension permission set license.
FieldServiceMobileUser:<value>
Adds the Field Service Mobile permission set license. Indicate a value between 1–25.
Supported Quantities
1–25, Multiplier: 1

More Information
See Assign Field Service Permissions in Salesforce Help for more information.

FieldServiceSchedulingUser:<value>
Adds the Field Service Scheduling permission set license. Indicate a value between 1–25.
Supported Quantities
1–25, Multiplier: 1

More Information
See Assign Field Service Permissions in Salesforce Help for more information.

FinanceLogging
Adds Finance Logging objects to a scratch org. This feature is required for Finance Logging.
FinancialServicesCommunityUser:<value>
Adds the Financial Services Insurance Community permission set license, and enables access to Financial Services insurance community components and objects. Indicate a value between 1–10.
Supported Quantities
1–10, Multiplier: 1

FinancialServicesInsuranceUser
Adds the Financial Services Insurance permission set license, and enables access to Financial Services insurance components and objects.
More Information
See Get Started with Financial Services Cloud for Insurance in Salesforce Help.

FinancialServicesUser:<value>
Adds the Financial Services Cloud Standard permission set license. This permission set enables access to Lightning components and the standard version of Financial Services Cloud. Also provides access to the standard Salesforce objects and custom Financial Services Cloud objects. Indicate a value between 1–10.
Supported Quantities
1–10, Multiplier: 1

FlowSites
Enables the use of flows in Salesforce Sites and customer portals.
ForceComPlatform
Adds one Salesforce Platform user license.
ForecastEnableCustomField
Enables custom currency and customer number fields for use as measures in forecasts based on opportunities.
More Information
Available in Enterprise Edition and Unlimited Edition scratch orgs, and requires enabling Salesforce Forecasting in Setup. See Salesforce Forecasting in Salesforce Help for more information.

FSCAlertFramework
Makes Financial Services Cloud Record Alert entities accessible in the scratch org.
More Information
Provides 11 seats of the FSCComprehensivePsl user license and 11 seats of the FSCComprehensiveAddOn add-on license.

Requires that you install Financial Services Cloud and OmniStudio. See Record Alerts in Financial Services Cloud Administrator Guide.

FSCServiceProcess
Enables the Service Process Studio feature of Financial Service Cloud. Provides 10 seats each of the IndustriesServiceExcellenceAddOn and FinancialServicesCloudStardardAddOn licenses. To enable the feature, you must also turn on the StandardServiceProcess setting in Setup and grant users the AccessToServiceProcess permission.
Fundraising
Gives users access to Nonprofit Cloud for Fundraising features and objects in Salesforce.
Scratch Org Definition File
See Nonprofit Cloud for Fundraising in Salesforce Help for more information. To enable Fundraising, add these settings to your scratch org definition file.

Note

The Fundraising licenses are assigned when the Fundraising feature is enabled in the scratch org. 

{
  "orgName": "Fundraising Org",
  "edition": "Enterprise",
  "features": [
    "AccountingSubledgerGrowthEdition",
    "IndustriesActionPlan",
    "AnalyticsQueryService",
    "PublicSectorAccess",
    "Fundraising",
    "IndustriesSalesExcellenceAddOn",
    "IndustriesServiceExcellenceAddOn",
    "MarketingUser",
    "ProgramManagement",
    "OmniStudioDesigner",
    "OmniStudioRuntime",
    "EnableSetPasswordInApi",
    "PersonAccounts"
  ],
  "settings": {
    "lightningExperienceSettings": {
      "enableS1DesktopEnabled": true
    },
    "IndustriesSettings": {
      "enableFundraising": true,
      "enableGiftEntryGrid": true,
      "enableGroupMembershipPref": true
    }
  }
}
GenericStreaming
Enables Generic Streaming API for API version 36.0 and earlier.
More Information
Available in Enterprise and Developer Edition scratch orgs.

GenStreamingEventsPerDay:<value>
Increases the maximum number of delivered event notifications within a 24-hour period, shared by all CometD clients, with generic streaming for API version 36.0 and earlier. Indicate a value between 10,000–50,000.
Supported Quantities
10,000–50,000, Multiplier: 1

Grantmaking
Gives users access to Grantmaking features and objects in Salesforce and Experience Cloud.
More Information
See Grantmaking in Salesforce Help for more information. To enable Grantmaking, add these settings to your scratch org definition file.

{
  "features": ["Grantmaking"],
  "settings": {
    "IndustriesSettings": {
      "enableGrantmaking": true
    }
  }
}
GuidanceHubAllowed
Enables the Guidance Center panel in Lightning Experience. The Guidance Center shows suggested and assigned content in the user’s flow of work. Suggested content is related to the app or page where the user is working. Assigned content includes guidance sets for Salesforce admins, links or Trailhead modules assigned to users with Learning Paths, and Enablement programs for sales reps.
More Information
Not available in Group Edition scratch orgs.

To use this scratch org feature, the Dev Hub org requires the GuidanceHubAllowed permission. If this permission isn't enabled in the Dev Hub, contact Salesforce Customer Support.

See Guidance Center in Salesforce Help for more information.

HealthCloudAddOn
Enables use of Health Cloud.
More Information
See Administer Health Cloud in Salesforce Help for more information.

HealthCloudEOLOverride
Salesforce retired the Health Cloud CandidatePatient object in Spring ‘22 to focus on the more robust Lead object. This scratch org feature allows you to override that retirement and access the object.
More Information
To use this scratch org feature, the Dev Hub org requires the HealthCloudEOLOverride permission. See Candidate Patient Data Entity Retirement in Salesforce Help for more information.

HealthCloudForCmty
Enables use of Health Cloud for Experience Cloud Sites.
More Information
See Experience Cloud Sites in Salesforce Help for more information.

HealthCloudMedicationReconciliation
Allows Medication Management to support Medication Reconciliation.
More Information
See Enable Medication Management to Perform Medication Reconciliation in Salesforce Help for more information.

HealthCloudPNMAddOn
Enables use of Provider Network Management.
More Information
See Provider Network Management in Salesforce Help for more information.

HealthCloudUser
This enables the scratch org to use the Health Cloud objects and features equivalent to the Health Cloud permission set license for one user.
More Information
See Assign Health Cloud Permission Sets and Permission Set Licenses in Salesforce Help for more information.

HighVelocitySales
Provides Sales Engagement licenses and enables Salesforce Inbox. Sales Engagement optimizes the inside sales process with a high-productivity workspace. Sales managers can create custom sales processes that guide reps through handling different types of prospects. And sales reps can rapidly handle prospects with a prioritized list and other productivity-boosting features. The Sales Engagement feature can be deployed in scratch orgs, but the settings for the feature can’t be updated through the scratch org definition file. Instead, configure settings directly in the Sales Engagement app.
HighVolumePlatformEventAddOn
Increases the daily delivery allocation of high-volume platform events or change data capture events by 100,000 events. This scratch org feature simulates the purchase of an add-on. If the org has the HighVolumePlatformEventAddOn, the daily allocation is flexible and isn’t enforced strictly to allow for usage peaks.
More Information
See Platform Event Allocations in the Platform Events Developer Guide.

HLSAnalytics
Enables the HLS Analytics org perm in scratch orgs.
More Information
Provides 1 seat of the HealthCareAnalyticsPlus add-on license.

HoursBetweenCoverageJob:<value>
The frequency in hours when the sharing inheritance coverage report can be run for an object. Indicate a value between 1–24.
Supported Quantities
1–24, Multiplier: 1

IdentityProvisioningFeatures
Enables use of Salesforce Identity User Provisioning.
IgnoreQueryParamWhitelist
Ignores allowlisting rules for query parameter filter rules. If enabled, you can add any query parameter to the URL.
Note

Where possible, we changed noninclusive terms to align with our company value of Equality. We maintained certain terms to avoid any effect on customer implementations. 

IndustriesActionPlan
Provides a license for Action Plans. Action Plans allow you to define the tasks or document checklist items for completing a business process.
More Information
Previous name: ActionPlan.

For more information and configuration steps, see Enable Actions Plans in Salesforce Help.

IndustriesBranchManagement
Branch Management lets branch managers and administrators track the work output of branches, employees, and customer segments in Financial Services Cloud.
More Information
Provides the Branch Management add-on license and user permissions, plus 11 seats of the FSCComprehensivePsl user license and 11 seats of the FSCComprehensiveAddOn add-on license.

Requires that you install Financial Services Cloud. See Branch Management in Financial Services Cloud Administrator Guide.

IndustriesCompliantDataSharing
Grants users access to participant management and advanced configuration for data sharing to improve compliance with regulations and company policies.
More Information
Provides 1 seat of the FinancialServicesCloudStandardAddOn add-on license.

Requires that you install Financial Services Cloud. See Compliant Data Sharing in Financial Services Cloud Administrator Guide.

IndustriesMfgAdvncdAccFrcs
Enables Advanced Account Forecasting. With Advanced Account Forecasting, generate comprehensive, multi-horizon forecasts for sales, operations, inventory, service, and other aspects of your business. Tailor your forecasting configurations to your objectives to generate accurate, relevant forecasts.
More Information
See Create Holistic, Multi-Enterprise Forecasts with Advanced Account Forecasting in Salesforce Help for more information.

IndustriesMfgPartnerVisitMgmt
Enables Partner Visit Management. Partner Visit Management helps sales managers in your company schedule visits to partner and distributor locations. Sales managers can use those visits to monitor performance, arrange for periodic check-ins, conduct trainings, upsell and cross-sell products, and follow up on sales agreement renewals and warranty expiration.
More Information
See Partner Visit Management in Manufacturing Cloud in Salesforce Help for more information.

IndustriesMfgProgram
Enables Program Based Business. With Program Based Business, program managers can manage the end-to-end lifecycle of a program where they derive forecasts based on their customers’ forecasts, transform these forecasts into business opportunities, and convert those opportunities into run-rate business. Program based business is common across multiple industries such as process, aerospace, defense, automotive, engineer-to-order, and make-to-order environments.
More Information
See Learn About Program Based Business in Salesforce Help for more information.

IndustriesMfgRebates
Enables Rebate Management. Manage incentive programs, track rebate attainment, automate payouts, and gain insights into sales performance and program effectiveness.
More Information
See Rebate Management in Salesforce Help for more information.

IndustriesMfgTargets
Enables Sales Agreements. With Sales Agreements, you can negotiate purchase and sale of products over a continued period. You can also get insights into products, prices, discounts, and quantities. And you can track your planned and actual quantities and revenues with real-time updates from orders and contracts.
More Information
See Track Sales Compliance with Sales Agreements in Salesforce Help for more information.

IndustriesManufacturingCmty
Provides the Manufacturing Sales Agreement for the Community permission set license, which is intended for the usage of partner community users. It also provides access to the Manufacturing community template for admins users to create communities.
More Information
See Improve Partner Collaboration with Communities in Salesforce Help for more information.

IndustriesMfgAccountForecast
Enables Account Forecast. With Account Forecast, you can generate forecasts for your accounts based on orders, opportunities, and sales agreements. You can also create formulas to calculate your forecasts per the requirements of your company.
More Information
See Create Account Forecasts to Enhance Your Planning in Salesforce Help for more information.

InsightsPlatform
Enables the CRM Analytics Plus license for CRM Analytics.
InsuranceCalculationUser
Enables the calculation feature of Insurance. Provides 10 seats each of the BRERuntimeAddOn and OmniStudioRuntime licenses. Also, provides one seat each of the OmniStudio and BREPlatformAccess licenses.
InsuranceClaimMgmt
Enables claim management features. Provides one seat of the InsuranceClaimMgmtAddOn license.
More Information
See Manage Claims in Salesforce Help for more information.

InsurancePolicyAdmin
Enables policy administration features. Provides one seat of the InsurancePolicyAdministrationAddOn license.
More Information
See Manage Insurance Policies in Salesforce Help for more information.

IntelligentDocumentReader
Provides the license required to enable and use Intelligent Document Reader in a scratch org. Intelligent Document Reader uses optical character recognition to automatically extract data with Amazon Textract by using your AWS account.
More Information
To use this scratch org feature, the Dev Hub org requires the EinsteinDocReader and BYOAForIFR permissions. For information about Intelligent Document Reader, see Intelligent Document Reader in Salesforce Help.

InvestigativeCaseManagement
Enables the objects, features, and permissions for managing investigative cases, including evidence management and case proceedings, in Public Sector Solutions.
Sample Scratch Org Definition File
To enable InvestigativeCaseManagement, add these features and settings to your scratch org definition file.

{
    "orgName": "ICM Org",
    "edition": "Developer",
    "features": [
    "InvestigativeCaseManagement:2"
    ],
    "settings": {
    "lightningExperienceSettings": {
    "enableS1DesktopEnabled": true
    },
    "mobileSettings": {
    "enableS1EncryptedStoragePref2": false
    },
    "industriesSettings": {
    "enableCarePlansPreference": true,
    "enableBenefitManagementPreference": true,
    "enableTimelinePref": true,
    "enableGroupMembershipPref": true,
    "enableIndustriesAssessment": true,
    "enableDiscoveryFrameworkMetadata": true,
    "enableInteractionSummaryPref": true,
    "enableEnhancedUIForISPref": true,
    "enableInteractionCstmSharingPref": true,
    "enableCaseProceedingsPref": true,
    "enableEvidenceManagementPref": true,
    "enableInvestigativeCaseMgmntPrf": true,
    "enableDisbursementPreference": true,
    "enableCaseReferralPref": true
    }
    }
    }
InvoiceManagement
Enables access to all the Billing features and objects that are available with the Revenue Cloud Advanced license in the scratch org.
More Information
Available in Enterprise, Unlimited, and Developer Edition scratch orgs.
Provides 10 seats of BillingAddOn add-on licenses.
Enable Billing in Revenue Cloud and turn on the required Billing settings.
Provides permission sets to access Billing features.
See Manage Billing in Revenue Cloud for more information.
Scratch Org Definition File
To enable InvoiceManagement, add these settings to your scratch org definition file.

{
  "orgName": "<Org Name>",
  "adminEmail":"<Admin Email Address>"
  "edition": "<Edition Name>",
  "features": [
    "InvoiceManagement"
    "EnableSetPasswordInApi"
  ],
  "settings": {
    "billingSettings": {
      "enableBillingSetup": true
    },
   "lightningExperienceSettings": {
        "enableS1DesktopEnabled": true
      }
  }
}
Interaction
Enables flows. A flow is the part of Salesforce Flow that collects data and performs actions in your Salesforce org or an external system. Salesforce Flow provides two types of flows: screen flows and autolaunched flows.
More Information
Requires configuration in the Setup menu of the scratch org.

IoT
Enables IoT so the scratch org can consume platform events to perform business and service workflows using orchestrations and contexts.
More Information
Also requires Metadata API Settings in the scratch org definition file.

JigsawUser
Provides one license to Jigsaw features.
Knowledge
Enables Salesforce Knowledge and gives your website visitors, clients, partners, and service agents the ultimate support tool. Create and manage a knowledge base with your company information, and securely share it when and where it's needed. Build a knowledge base of articles that can include information on process, like how to reset your product to its defaults, or frequently asked questions.
More Information
See Salesforce Knowledge in Salesforce Help for more information.

LegacyLiveAgentRouting
Enables legacy Live Agent routing for Chat. Use Live Agent routing to chat in Salesforce Classic. Chats in Lightning Experience must be routed using Omni-Channel.
LightningSalesConsole
Adds one Lighting Sales Console user license.
LightningScheduler
Enables Lightning Scheduler. Lightning Scheduler gives you tools to simplify appointment scheduling in Salesforce. Create a personalized experience by scheduling customer appointments—in person, by phone, or by video—with the right person at the right place and time.
More Information
See Manage Appointments with Lightning Scheduler in Salesforce Help for more information.

LightningServiceConsole
Assigns the Lightning Service Console License to your scratch org so you can use the Lightning Service Console and access features that help manage cases faster.
More Information
See Lightning Service Console in Salesforce Help for more information.

LiveAgent
Enables Chat for Service Cloud. Use web-based chat to quickly connect customers to agents for real-time support.
LiveMessage
Enables Messaging for Service Cloud. Use Messaging to quickly support customers using apps such as SMS text messaging and Facebook Messenger.
LongLayoutSectionTitles
Allows page layout section titles to be up to 80 characters.
More Information
To turn on this feature, contact Salesforce Customer Support.

LoyaltyAnalytics
Enables Analytics for Loyalty license. The Analytics for Loyalty app gives you actionable insights into your loyalty programs.
More Information
See Analytics for Loyalty in Salesforce Help for more information.

LoyaltyEngine
Enables Loyalty Management Promotion Setup license. Promotion setup allows loyalty program managers to create loyalty program processes. Loyalty program processes help you decide how incoming and new Accrual and Redemption-type transactions are processed.
More Information
See Create Processes with Promotion Setup in Salesforce Help for more information.

LoyaltyManagementStarter
Enables the Loyalty Management - Starter license. Create loyalty programs and set up loyalty program-specific processes that allow you to recognize, rewards, and retain customers.
More Information
See Loyalty Management in Salesforce Help for more information.

LoyaltyMaximumPartners:<value>
Increases the number of loyalty program partners that can be associated with a loyalty program in an org where the Loyalty Management - Starter license is enabled. The default and maximum value is 1.
Supported Quantities
0–1, Multiplier: 1

LoyaltyMaximumPrograms:<value>
Increases the number of loyalty programs that can be created in an org where the Loyalty Management - Starter license is enabled. The default and maximum value is 1.
Supported Quantities
0–1, Multiplier: 1

LoyaltyMaxOrderLinePerHour:<value>
Increases the number of order lines that can be cumulatively processed per hour by loyalty program processes. Indicate a value between 1–3,500,000.
Supported Quantities
1–3,500,000, Multiplier: 1

LoyaltyMaxProcExecPerHour:<value>
Increases the number of transaction journals that can be processed by loyalty program processes per hour. Indicate a value between 1–500,000.
Supported Quantities
1–500,000, Multiplier: 1

LoyaltyMaxTransactions:<value>
Increases the number of Transaction Journal records that can be processed. Indicate a value between 1–50,000,000.
Supported Quantities
1–50,000,000, Multiplier: 1

LoyaltyMaxTrxnJournals:<value>
Increases the number of Transaction Journal records that can be stored in an org that has the Loyalty Management - Start license enabled.
Supported Quantities
1–25,000,000, Multiplier: 1

More Information
See Transaction Journal Limits in Salesforce Help for more information.

Macros
Enables macros in your scratch org. After enabling macros, add the macro browser to the Lightning Console so you can configure predefined instructions for commonly used actions and apply them to multiple posts at the same time.
More Information
See Set Up and Use Macros in Salesforce Help for more information.

MarketingCloud
Provides licenses for Marketing Cloud Growth edition. These licenses provide access to campaigns, flows, emails, forms, landing pages, and consent management features. You can send up to 20 emails per day from a scratch org.
Scratch Org Definition File
{
   "features": [
      "MarketingCloud",
      "CustomerDataPlatform",
      "CustomerDataPlatformLite",
      "EnableSetPasswordInApi",
   ],
   "settings": {
      "customerDataPlatformSettings": {
         "enableCustomerDataPlatform": true
      },
      "lightningExperienceSettings": {
         "enableS1DesktopEnabled": true
      },
      "mobileSettings": {
         "enableS1EncryptedStoragePref2": false
      }
   }
}
More Information
Marketing Cloud Growth edition uses Data Cloud to store engagement events, create segments, personalize messages, process decisions in flows, and generate analytics. Salesforce ISVs that develop applications for Marketing Cloud Growth edition must have the Data Cloud Scratch Org permission enabled in their Partner Business Orgs.

You can enable Data Cloud in your scratch org by creating a case with Salesforce Partner Support. Use this template as a guide when you submit your request, replacing {your_org_id_here} with the ID of your Partner Business Org:

Subject: Enable Data Cloud for scratch orgs in Dev Hub
Description: Please enable Data Cloud scratch org permissions on my Partner Business Org. My org ID is {your_org_id_here}
Product and Topic: Partner Programs & Benefits (License Request - Trial/Dev Org)
After Salesforce Partner Support completes your request, add the CustomerDataPlatform and CustomerDataPlatformLite features to your scratch org definition file.

MarketingUser
Provides access to the Campaigns object. Without this setting, Campaigns are read-only.
MaterialityAssessment
Provides the permission set licenses and permission sets required to configure materiality assessment in Net Zero Cloud.
Scratch Org Definition File
Add these options to your scratch org definition file:

{
    "orgName": "NZC Package Dev",
    "edition": "Enterprise",
    "features": [
      "DisclosureFramework",
      "DocGen",
      "DocGenDesigner",
      "DocGenInd",
      "OmnistudioDesigner",
      "OmnistudioRuntime",
      "SurveyAdvancedFeatures",
      "SustainabilityApp",
      "MaterialityAssessment:1"
    ],
    "settings": {
      "industriesSettings": {
        "enableGnrcDisclsFrmwrk": true,
        "enableIndustriesAssessment": true,
        "enableSustainabilityCloud": true,
        "enableSCCarbonAccounting": true,
        "enableSCSNGManagement": true,
        "enableMaterialityAssessment": true,
        "enableInformationLibrary": true
    }
  }
}
More Information
For configuration steps, see Configure Net Zero Cloud and Enable the Disclosure and Compliance Hub in the Set Up and Maintain Net Zero Cloud guide in Salesforce Help.

MaxActiveDPEDefs:<value>
Increases the number of Data Processing Engine definitions that can be activated in the org. Indicate a value between 1–50.
Supported Quantities
1–50, Multiplier: 1

MaxApexCodeSize:<value>
Limits the non-test, unmanaged Apex code size (in MB). To use a value greater than the default value of 10, contact Salesforce Customer Support.
MaxAudTypeCriterionPerAud
Limits the number of audience type criteria available per audience. The default value is 10.
MaxCustomLabels:<value>
Limits the number of custom labels (measured in thousands). Setting the limit to 10 enables the scratch org to have 10,000 custom labels. Indicate a value between 1–15.
Supported Quantities
1–15, Multiplier: 1,000

MaxDatasetLinksPerDT:<value>
Increases the number of dataset links that can be associated with a decision table. Indicate a value between 1–3.
Supported Quantities
1–3, Multiplier: 1

MaxDataSourcesPerDPE:<value>
Increases the number of Source Object nodes a Data Processing Engine definition can contain. Indicate a value between 1–50.
Supported Quantities
1–50, Multiplier: 1

MaxDecisionTableAllowed:<value>
Increases the number of decision tables rules that can be created in the org. Indicate a value between 1–30.
Supported Quantities
1–30, Multiplier: 1

MaxFavoritesAllowed:<value>
Increases the number of Favorites allowed. Favorites allow users to create a shortcut to a Salesforce Page. Users can view their Favorites by clicking the Favorites list dropdown in the header. Indicate a value between 0–200.
Supported Quantities
0–200, Multiplier: 1

MaxFieldsPerNode:<value>
Increases the number of fields a node in a Data Processing Engine definition can contain. Indicate a value between 1–500.
Supported Quantities
1–500, Multiplier: 1

MaxInputColumnsPerDT:<value>
Increases the number of input fields a decision table can contain. Indicate a value between 1–10.
Supported Quantities
1–10, Multiplier: 1

MaxLoyaltyProcessRules:<value>
Increases the number of loyalty program process rules that can be created in the org. Indicate a value between 1–20.
Supported Quantities
1–20, Multiplier: 1

MaxNodesPerDPE:<value>
Increases the number of nodes that a Data Processing Engine definition can contain. Indicate a value between 1–500.
Supported Quantities
1–500, Multiplier: 1

MaxNoOfLexThemesAllowed:<value>
Increases the number of Themes allowed. Themes allow users to configure colors, fonts, images, sizes, and more. Access the list of Themes in Setup, under Themes and Branding. Indicate a value between 0–300.
Supported Quantities
0–300, Multiplier: 1

MaxOutputColumnsPerDT:<value>
Increases the number of output fields a decision table can contain. Indicate a value between 1–5.
Supported Quantities
1–5, Multiplier: 1

MaxSourceObjectPerDSL:<value>
Increases the number of source objects that can be selected in a dataset link of a decision table. Indicate a value between 1–5.
Supported Quantities
1–5, Multiplier: 1

MaxStreamingTopics:<value>
Increases the maximum number of delivered PushTopic event notifications within a 24-hour period, shared by all CometD clients. Indicate a value between 40–100.
Supported Quantities
40–100, Multiplier: 1

MaxUserNavItemsAllowed:<value>
Increases the number of navigation items a user can add to the navigation bar. Indicate a value between 0–500.
Supported Quantities
0–500, Multiplier: 1

MaxUserStreamingChannels:<value>
Increases the maximum number of user-defined channels for generic streaming. Indicate a value between 20–1,000.
Supported Quantities
20–1,000, Multiplier: 1

MaxWishlistsItemsPerWishlist
Limits the number of wishlist items per wishlist. The default value is 500.
More Information
For more information, see Salesforce Help at Salesforce B2B Commerce and D2C Commerce

MaxWishlistsPerStoreAccUsr
Limits the number of wishlists allowed per store, account, and user. The default value is 100.
For example, if User1 is associated with Store1 and Store2, and has access to Account1 and Account2, then the wishlist limit is the same for the combinations of User1 with Store1 and Account1, User1 with Store2 and Account2, and User1 with Store1 and Account2.

More Information
For more information, see Salesforce Help at Salesforce B2B Commerce and D2C Commerce.

MaxWritebacksPerDPE:<value>
Increases the number of Writeback Object nodes a Data Processing Engine definition can contain. Indicate a value between 1–50.
Supported Quantities
1–10, Multiplier: 1

MedVisDescriptorLimit:<value>
Increases the number of sharing definitions allowed per record for sharing inheritance to be applied to an object. Indicate a value between 150–1,600.
Supported Quantities
150–1,600, Multiplier: 1

MinKeyRotationInterval
Sets the encryption key material rotation interval at once per 60 seconds. If this feature isn't specified, the rotation interval defaults to once per 604,800 seconds (7 days) for Search Index key material, and once per 86,400 seconds (24 hours) for all other key material.
More Information
Requires enabling PlatformEncryption and some configuration using the Setup menu in the scratch org. See Which User Permissions Does Shield Platform Encryption Require? and Generate a Tenant Secret with Salesforce in Salesforce Help.

MobileExtMaxFileSizeMB:<value>
Increases the file size (in megabytes) for Field Service Mobile extensions. Indicate a value between 1–2,000.
Supported Quantities
1–2,000, Multiplier: 1

MobileSecurity
Enables Enhanced Mobile Security. With Enhanced Mobile Security, you can control a range of policies to create a security solution tailored to your org’s needs. You can limit user access based on operating system versions, app versions, and device and network security. You can also specify the severity of a violation.
MobileVoiceAndLLM
Allows mobile apps to download large language models (LLMs) and voice models for offline use from the model store service. Normally, mobile apps have access to the model store service when Einstein is enabled, but the MobileVoiceAndLLM scratch org feature enables offline voice without requiring orgs to fully enable Einstein.
Sample Scratch Org Definition File
This sample scratch org definition file enables MobileVoiceAndLLM. Additionally, the sample scratch org definition configures lightningExperienceSettings and mobileSettings.

{
  "orgName": "Acme",
  "edition": "Developer",
  "features": ["MobileVoiceAndLLM"],
  "settings": {
    "lightningExperienceSettings": {
      "enableS1DesktopEnabled": true
    },
    "mobileSettings": {
      "enableS1EncryptedStoragePref2": false
    }
  }
}
MultiLevelMasterDetail
Allows the creation a special type of parent-child relationship between one object, the child, or detail, and another object, the parent, or master.
MutualAuthentication
Requires client certificates to verify inbound requests for mutual authentication.
MyTrailhead
Enables access to a myTrailhead enablement site in a scratch org.
Scratch Org Definition File
Add these options to your scratch org definition file:

{
  "orgName": "Acme",
  "edition": "Enterprise",
  "features": ["MyTrailhead"],
  "settings": {
    "trailheadSettings": {
      "enableMyTrailheadPref": true
    }
  }
}
More Information
Salesforce Help: Enablement Sites (myTrailhead)

NonprofitCloudCaseManagementUser
Provides the permission set license required to use and configure the Salesforce.org Nonprofit Cloud Case Management managed package. You can then install the package in the scratch org.
More Information
For installation and configuration steps, see Salesforce.org Nonprofit Cloud Case Management.

NumPlatformEvents:<value>
Increases the maximum number of platform event definitions that can be created. Indicate a value between 5–20.
Supported Quantities
5–20, Multiplier: 1

ObjectLinking
Create rules to quickly link channel interactions to objects such as contacts, leads, or person accounts for customers (Beta).
OmnistudioMetadata
Enables Omnistudio metadata API. Using this API, customers can deploy and retrieve Omnistudio components programmatically. 
For more information, see Enable OmniStudio Metadata API Support.

OmnistudioRuntime
Enables business users to execute OmniScripts, DataMappers, FlexCards, and so on in the employee facing applications.
OmnistudioDesigner
Enables administrator or developer to create new OmniScripts/ DataMappers / Integration Procedures instances.
OrderManagement
Provides the Salesforce Order Management license. Order Management is your central hub for handling all aspects of the order lifecycle, including order capture, fulfillment, shipping, payment processing, and servicing.
More Information
Available in Enterprise and Developer Edition scratch orgs.

If you want to configure Order Management to use any of these features, enable it in your scratch org:

MultiCurrency
PersonAccounts
ProcessBuilder
StateAndCountryPicklist
Requires configuration using the Setup menu in the scratch org. For installation and configuration steps, see Salesforce Help: Salesforce Order Management.

Note

The implementation process includes turning on several Order and Order Management feature toggles in Setup. In a scratch org, you can turn them on by including metadata settings in your scratch org definition file. For details about these settings, see OrderSettings and OrderManagementSettings in the Metadata API Developer Guide.

OrderSaveLogicEnabled
Enables scratch org support for New Order Save Behavior. OrderSaveLogicEnabled supports only New Order Save Behavior. If your scratch org needs both Old and New Order Save Behavior, use OrderSaveBehaviorBoth.
Scratch Org Definition File
To enable OrderSaveLogicEnabled, update your scratch org definitions file.

{
  "features": ["OrderSaveLogicEnabled"],
  "settings": {
    "orderSettings": {
      "enableOrders": true
    }
  }
}
OrderSaveBehaviorBoth
Enables scratch org support for both New Order Save Behavior and Old Order Save Behavior.
Scratch Org Definition File
To enable OrderSaveLogicEnabled, update your scratch org definitions file.

{
  "features": ["OrderSaveBehaviorBoth"],
  "settings": {
    "orderSettings": {
      "enableOrders": true
    }
  }
}
OutboundMessageHTTPSession
Enables using HTTP endpoint URLs in outbound message definitions that have the Send Session ID option selected.
OutcomeManagement
Gives users access to Outcome Management features and objects in Salesforce and Experience Cloud.
More Information
See Outcome Management in Salesforce Help for more information. To enable Outcome Management, add these settings to your scratch org definition file.

{
  "features": ["OutcomeManagement"],
  "settings": {
    "IndustriesSettings": {
      "enableOutcomes": true
    }
  }
}
PardotScFeaturesCampaignInfluence
Enables additional campaign influence models, first touch, last touch, and even distribution for Pardot users.
PersonAccounts
Enables person accounts in your scratch org.
More Information
Available in Enterprise and Developer Edition scratch orgs.

PipelineInspection
Enables Pipeline Inspection. Pipeline Inspection is a consolidated pipeline view with metrics, opportunities, and highlights of recent changes.
More Information
Available in Enterprise Edition scratch orgs. To enable Pipeline Inspection in your scratch org, add this setting in your scratch org definition file.

"settings": {
    ...
    "opportunitySettings": {
      "enablePipelineInspectionFlow": true
    },
    ...
  }
PlatformCache
Enables Platform Cache and allocates a 3 MB cache. The Lightning Platform Cache layer provides faster performance and better reliability when caching Salesforce session and org data.
More Information
See Platform Cache in the Apex Developer Guide for more information.

PlatformConnect:<value>
Enables Salesforce Connect and allows your users to view, search, and modify data that's stored outside your Salesforce org. Indicate a value from 1–5.
Supported Quantities
1–5, Multiplier: 1

PlatformEncryption
Shield Platform Encryption encrypts data at rest. You can manage key material and encrypt fields, files, and other data.
PlatformEventsPerDay:<value>
Increases the maximum number of delivered standard-volume platform event notifications within a 24-hour period, shared by all CometD clients. Indicate a value between 10,000–50,000.
Supported Quantities
10,000–50,000, Multiplier: 1

ProcessBuilder
Enables Process Builder, a Salesforce Flow tool that helps you automate your business processes.
More Information
Requires configuration in the Setup menu of the scratch org.

See Process Builder in Salesforce Help for more information.

ProductsAndSchedules
Enables product schedules in your scratch org. Enabling this feature lets you create default product schedules on products. Users can also create schedules for individual products on opportunities.
ProductCatalogManagementAddOn
Enables read-write access to Product Catalog Management features and objects.
More Information
Available in Developer and Enterprise scratch org editions. Provides 1 Product Catalog Management add-on license.

ProductCatalogManagementViewerAddOn
Enables read access to Product Catalog Management features and objects.
More Information
Available in Developer and Enterprise scratch org editions. Provides 1 Product Catalog Management Viewer add-on license.

ProductCatalogManagementPCAddOn
Enables read access to Product Catalog Management features and objects for Partner Community Users in scratch orgs.
More Information
Available in Developer and Enterprise scratch org editions.
Provides 1 Product Catalog Management add-on license.
Requires a partner community user to be set up. The partner community user must be granted the Product Catalog Management Partner Community add-on license.
ProgramManagement
Enables access to all Program Management and Case Management features and objects.
More Information
To enable ProgramManagement, add these settings to your scratch org definition file.

{
  "orgName": "Sample Org" ,
  "edition": "Enterprise",
  "features": ["ProgramManagement"],
  "settings": {
    "IndustriesSettings": {
      "enableBenefitManagementPreference": true,
      "enableBenefitAndGoalSharingPref": true,
      "enableCarePlansPreference": true
    }
  }
}
Alternatively, enable the settings in the org manually. See Enable Program Management in Salesforce Help.

ProviderFreePlatformCache
Provides 3 MB of free Platform Cache capacity for security-reviewed managed packages. This feature is made available through a capacity type called Provider Free capacity and is automatically enabled in Developer Edition orgs. Allocate the Provider Free capacity to a Platform Cache partition and add it to your managed package.
More Information
See Set Up a Platform Cache Partition with Provider Free Capacity in Salesforce Help for more information.

ProviderManagement
Enables the objects, features, and permissions for managing provider networks, care plans, and service delivery in Public Sector Solutions.
Sample Scratch Org Definition File
To enable ProviderManagement, add these features and settings to your scratch org definition file.

{
    "orgName": "Provider Management Org",
    "edition": "Developer",
    "features": ["ProviderManagement:2"],
    "settings": {
    "lightningExperienceSettings": {
    "enableS1DesktopEnabled": true
    },
    "mobileSettings": {
    "enableS1EncryptedStoragePref2": false
    },
    "IndustriesSettings": {
    "enableBenefitAndGoalSharingPref": true,
    "enableBenefitManagementPreference": true,
    "enableCarePlansPreference": true,
    "enableCaseReferralPref": true,
    "enableProviderManagementPref": true,
    "enableProviderMgmtSharingPref": true,
    "enableDisbursementPreference": true
    }
    }
    }
PSSAssetManagement
Enables the objects, features, and permissions for managing assets in Public Sector Solutions.
Sample Scratch Org Definition File
To enable PSSAssetManagement, add these features and settings to your scratch org definition file.

{
    "orgName": "PSS Asset Management Org",
    "edition": "Enterprise",
    "features": [
    "PSSAssetManagement"
    ],
    "settings": {
    "industriesSettings": {
    "enableIndustriesAssessment": true,
    "enableDiscoveryFrameworkMetadata": true
    }
    }
    }
PublicSectorAccess
Enables access to all Public Sector features and objects.
PublicSectorApplicationUsageCreditsAddOn
Enables additional usage of Public Sector applications based on their pricing.
PublicSectorSiteTemplate
Allows Public Sector users access to build an Experience Cloud site from the templates available.
RateManagement
Enables Rate Management that allows you to set, manage, and optimize rates for usage-based products.
More Information
Provides these set of licenses:
5 RatingEngineAccess platform licenses
5 RatingRunTimeAddOn add-on licenses
5 RatingDesignTimeAddOn add-on licenses
10 FullCRM licenses
Requires you to enable CoreCpq to access Rate Management.
See Configure Rate Pricing Calculations in Revenue Cloud in Salesforce Help for more information.

RecordTypes
Enables Record Type functionality. Record Types let you offer different business processes, picklist values, and page layouts to different users.
RefreshOnInvalidSession
Enables automatic refreshes of Lightning pages when the user's session is invalid. If, however, the page detects a new token, it tries to set that token and continue without a refresh.
RevSubscriptionManagement
Enables Subscription Management. Subscription Management is an API-first, product-to-cash solution for B2B subscriptions and one-time sales.
More Information
Available in Enterprise and Developer scratch orgs. To enable Subscription Management in your scratch org, add this setting in your scratch org definition file.

"settings": {
    ...
    "subscriptionManagementSettings": {
      "enableSubscriptionManagement": true
    },
    ...
  }
For more information about Subscription Management, see https://developer.salesforce.com/docs/revenue/subscription-management/overview.

S1ClientComponentCacheSize
Allows the org to have up to 5 pages of caching for Lightning Components.
SalesCloudEinstein
Enables Sales Cloud Einstein features and Salesforce Inbox. Sales Cloud Einstein brings AI to every step of the sales process.
More Information
Available in Enterprise Edition scratch orgs.

See Sales Cloud Einstein in Salesforce Help for more information.

SalesforceContentUser
Enables access to Salesforce content features.
SalesforceFeedbackManagementStarter
Provides a license to use the Salesforce Feedback Management - Starter features.
More Information
Available in Enterprise and Developer edition scratch orgs. To use the Salesforce Feedback Management - Starter features, enable Surveys and assign the Salesforce Advanced Features Starter user permission to the scratch org user. For additional information on how to enable Surveys and configuration steps, see Enable Surveys and Configure Survey Settings and Assign User Permissions in Salesforce Help.

SalesforceHostedMCP
Enables hosted MCP servers on the scratch org. With this scratch org feature parameter, MCP clients can connect to available hosted MCP servers.
More Information
Use of Salesforce hosted MCP servers requires setup of external clients. See Salesforce Hosted MCP Severs in Salesforce Help.

SalesforceIdentityForCommunities
Adds Salesforce Identity components, including login and self-registration, to Experience Builder. This feature is required for Aura components.
SalesforcePricing
Enables Salesforce Pricing, which allows you to set, manage, and optimize prices across your entire product portfolio
More Information
Provides 5 Salesforce Pricing Design Time AddOn, 5 Salesforce Pricing Run Time AddOn licenses. For more information, see Salesforce Pricing in Salesforce Help.

SalesUser
Provides a license for Sales Cloud features.
SAML20SingleLogout
Enables usage of SAML 2.0 single logout.
SCIMProtocol
Enables access support for the SCIM protocol base API.
ScvMultipartyAndConsult
Enables you to set up and test multiparty calls and consult calls for Service Cloud Voice with Partner Telephony.
More Information
This feature requires that you also include the ServiceCloudVoicePartnerTelephony scratch org feature in your scratch org definition file. Available in Salesforce Enterprise, Unlimited, and Developer Editions.

For setup and configuration steps, see Manage Multiparty Calls and Consult Calls in the Service Cloud Voice for Partner Telephony Developer Guide.

Sample Scratch Org Definition File
{
  "orgName": "MultipartyScratchOrg",
  "edition": "Developer",
  "features": ["ScvMultipartyAndConsult", "ServiceCloudVoicePartnerTelephony"]
  "settings": {
    "lightningExperienceSettings": {
      "enableS1DesktopEnabled": true
     },
   "mobileSettings": {
      "enableS1EncryptedStoragePref2": false
    }
  }
}
SecurityEventEnabled
Enables access to security events in Event Monitoring.
SentimentInsightsFeature
Provides the license required to enable and use Sentiment Insights in a scratch org. Use Sentiment Insights to analyze the sentiment of your customers and get actionable insights to improve it.
More Information
To use this scratch org feature, the Dev Hub org requires the IESentimentAnalysis, AwsSentimentAnalysis, BYOAForSentiment, and IESentimentAnalysisEnabled permissions. For information about Sentiment Insights, see Sentiment Insights in Salesforce Help.

ServiceCatalog
Enables Employee Service Catalog so you can create a catalog of products and services for your employees. It can also turn your employees' requests for these products and services into approved and documented orders.
More Information
To use this scratch org feature, the Dev Hub org requires the ServiceCatalog permission. To learn more, see Employee Service Catalog.

ServiceCloud
Assigns the Service Cloud license to your scratch org, so you can choose how your customers can reach you, such as by email, phone, social media, online communities, chat, and text.
ServiceCloudVoicePartnerTelephony
Assigns the Service Cloud Voice with Partner Telephony add-on license to your scratch org, so you can set up a Service Cloud Voice contact center that integrates with supported telephony providers. Indicate a value from 1–50.
Supported Quantities
1–50, Multiplier: 1

More Information
For setup and configuration steps, see Service Cloud Voice with Partner Telephony in Salesforce Help.

ServiceUser
Adds one Service Cloud User license, and allows access to Service Cloud features.
SessionIdInLogEnabled
Enables Apex debug logs to include session IDs. If disabled, session IDs are replaced with "SESSION_ID_REMOVED" in debug logs.
SFDOInsightsDataIntegrityUser
Provides a license to Salesforce.org Insights Platform Data Integrity managed package. You can then install the package in the scratch org.
More Information
For installation and configuration steps, see the Salesforce.org Insights Platform Data Integrity help.

SharedActivities
Allow users to relate multiple contacts to tasks and events.
More Information
For additional installation and configuration steps, see Considerations for Enabling Shared Activities in Salesforce Help.

Sites
Enables Salesforce Sites, which allows you to create public websites and applications that are directly integrated with your Salesforce org. Users aren’t required to log in with a username and password.
More Information
You can create sites and communities in a scratch org, but custom domains, such as www.example.com, aren't supported.

SocialCustomerService
Enables Social Customer Service, sets post defaults, and either activates the Starter Pack or signs into your Social Studio account.
StateAndCountryPicklist
Enables state and country/territory picklists. State and country/territory picklists let users select states and countries from predefined, standardized lists, instead of entering state, country, and territory data into text fields.
StreamingAPI
Enables Streaming API.
More Information
Available in Enterprise and Developer Edition scratch orgs.

StreamingEventsPerDay:<value>
Increases the maximum number of delivered PushTopic event notifications within a 24-hour period, shared by all CometD clients (API version 36.0 and earlier). Indicate a value between 10,000–50,000.
Supported Quantities
10,000–50,000, Multiplier: 1

SubPerStreamingChannel:<value>
Increases the maximum number of concurrent clients (subscribers) per generic streaming channel (API version 36.0 and earlier). Indicate a value between 20–4,000.
Supported Quantities
20–4,000, Multiplier: 1

SubPerStreamingTopic:<value>
Increases the maximum number of concurrent clients (subscribers) per PushTopic streaming channel (API version 36.0 and earlier). Indicate a value between 20–4,000.
Supported Quantities
20–4,000, Multiplier: 1

SurveyAdvancedFeatures
Enables a license for the features available with the Salesforce Feedback Management - Growth license.
More Information
Available in Enterprise and Developer edition scratch orgs. To use the Salesforce Feedback Management - Growth features, enable Surveys and assign the Salesforce Surveys Advanced Features user permission to the scratch org user. For additional information on how to enable Surveys and configuration steps, see Enable Surveys and Configure Survey Settings and Assign User Permissions in Salesforce Help.

SustainabilityCloud
Provides the permission set licenses and permission sets required to install and configure Sustainability Cloud. To enable or use CRM Analytics and CRM Analytics templates, include the DevelopmentWave scratch org feature.
More Information
For installation and configuration steps, see Sustainability Cloud Legacy Documentation in the Set Up and Maintain Net Zero Cloud guide in Salesforce Help.

SustainabilityApp
Provides the permission set licenses and permission sets required to configure Net Zero Cloud. To enable or use Tableau CRM and Tableau CRM templates, include the DevelopmentWave scratch org feature.
Scratch Org Definition File
Add these options to your scratch org definition file:

{
  "orgName": "net zero scratch org",
  "edition": "Developer",
  "features": ["SustainabilityApp"],
  "settings": {
    "industriesSettings": {
      "enableSustainabilityCloud": true,
      "enableSCCarbonAccounting": true
    }
  }
}
More Information
For configuration steps, see Configure Net Zero Cloud in the Set Up and Maintain Net Zero Cloud guide in Salesforce Help.

TalentRecruitmentManagement
Enables the objects, features, and permissions for managing the talent recruitment and hiring process in Public Sector Solutions.
Sample Scratch Org Definition File
To enable TalentRecruitmentManagement, add these features and settings to your scratch org definition file.

{
    "orgName": "TRM Org",
    "edition": "Developer",
    "features": [
    "TalentRecruitmentManagement:4"
    ],
    "settings": {
    "lightningExperienceSettings": {
    "enableS1DesktopEnabled": true
    },
    "mobileSettings": {
    "enableS1EncryptedStoragePref2": false
    },
    "IndustriesSettings": {
    "enablePositionRecruitmentPref": true,
    "enableIndustriesAssessment": true,
    "enableDiscoveryFrameworkMetadata": true,
    "enableCriteriaBasedSearchAndFilter": true
    },
    "DocumentChecklistSettings": {
    "deleteDCIWithFiles": true
    }
    }
    }
TCRMforSustainability
Enables all permissions required to manage the Net Zero Analytics app by enabling Tableau CRM. You can create and share the analytics app for your users to bring your environmental accounting in line with your financial accounting.
More Information
For more information, see Deploy Net Zero Analytics in the Set Up and Maintain Net Zero Cloud guide in Salesforce Help.

TimelineConditionsLimit
Limits the number of timeline record display conditions per event type to 3.
More Information
See Provide Holistic Patient Care with Enhanced Timeline in Salesforce Help for more information.

TimelineEventLimit
Limits the number of event types displayed on a timeline to 5.
More Information
See Provide Holistic Patient Care with Enhanced Timeline in Salesforce Help for more information.

TimelineRecordTypeLimit
Limits the number of related object record types per event type to 3.
More Information
See Provide Holistic Patient Care with Enhanced Timeline in Salesforce Help for more information.

TimeSheetTemplateSettings
Time Sheet Templates let you configure settings to create time sheets automatically. For example, you can create a template that sets start and end dates. Assign templates to user profiles so that time sheets are created for the right users.
More Information
For configuration steps, see Create Time Sheet Templates in Salesforce Help.

TransactionFinalizers
Enables you to implement and attach Apex Finalizers to Queueable Apex jobs.
More Information
Note

This functionality is currently in open pilot and subject to restrictions.

See the Transaction Finalizers (Pilot) in Apex Developer Guide for more information.

UsageManagement
Enables Usage Management. Using Usage Management, you can setup, track, and manage the consumption of usage-based products.
More Information
Provides 5 UsageManagementAddOn add-on licenses and 10 FullCRM licenses.
See Usage Management in Salesforce Help for more information.

WaveMaxCurrency
Increases the maximum number of supported currencies for CRM Analytics. Indicate a value between 1–5.
WavePlatform
Enables the Wave Platform license.
Workflow
Enables Workflow so you can automate standard internal procedures and processes.
More Information
Requires configuration in the Setup menu of the scratch org.

WorkflowFlowActionFeature
Allows you to launch a flow from a workflow action.
More Information
This setting is supported only if you enabled the pilot program in your org for flow trigger workflow actions. If you enabled the pilot, you can continue to create and edit flow trigger workflow actions.

If you didn't enable the pilot, use the Flows action in the ProcessBuilder scratch org feature instead.

WorkplaceCommandCenterUser
Enables access to Workplace Command Center features including access to objects such as Employee, Crisis, and EmployeeCrisisAssessment.
More Information
For additional installation and configuration steps, see Set Up Your Work.com Development Org in the Workplace Command Center for Work.com Developer Guide.

WorkThanksPref
Enables the give thanks feature in Chatter.