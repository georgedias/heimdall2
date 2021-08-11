import {ExecJSON} from 'inspecjs';
import _ from 'lodash';
import {version as HeimdallToolsVersion} from '../package.json';
import {
  BaseConverter,
  ILookupPath,
  impactMapping,
  MappedTransform,
  parseHtml
} from './base-converter';
import {encode} from 'html-entities'
import path from 'path'
import {AwsConfigMapping} from './mappings/AwsConfigMapping'
import {AwsConfigMappingItem} from './mappings/AwsConfigMappingItem'

const IMPACT_MAPPING: Map<string, number> = new Map([
  ['CRITICAL', 0.9],
  ['HIGH', 0.7],
  ['MEDIUM', 0.5],
  ['LOW', 0.3],
  ['INFORMATIONAL', 0.0]
]);

const DEFAULT_NIST_TAG = ['SA-11', 'RA-5']

const FIREWALL_MANAGER_REGEX = /arn:.+:securityhub:.+:.*:product\/aws\/firewall-manager/
const SECURITYHUB_REGEX = /arn:.+:securityhub:.+:.*:product\/aws\/securityhub/
const PROWLER_REGEX = /arn:.+:securityhub:.+:.*:product\/prowler\/prowler/

const PRODUCT_ARN_MAPPING: Map<RegExp, Record<string, Function>> = new Map([
  [FIREWALL_MANAGER_REGEX, getFirewallManager()],
  [SECURITYHUB_REGEX, getSecurityHub()],
  [PROWLER_REGEX, getProwler()]
]);

function fixFileInput(asffJson: string) {
  let output = JSON.parse(asffJson)
  if (!_.has(output, 'Findings')) {
    output = {Findings: [output]}
  }
  return output
}
function getFirewallManager(): Record<string, Function> {
  const findingId = (finding: unknown, {...other}): string => encode(_.get(finding, 'Title'))
  const productName = (findings: unknown[], {...other}): string => encode(`${_.get(findings[0], 'ProductFields.aws/securityhub/CompanyName')} ${_.get(findings[0], 'ProductFields.aws/securityhub/ProductName')}`)
  return {
    findingId,
    productName
  }
}
function getProwler(): Record<string, Function> {
  const subfindingsCodeDesc = (finding: unknown, {...other}): string => encode(_.get(finding, 'Description'))
  const findingId = (finding: unknown, {...other}): string => {
    let generatorId = _.get(finding, 'GeneratorId')
    let hyphenIndex = generatorId.indexOf('-')
    return encode(generatorId.slice(hyphenIndex + 1))
  }
  const productname = (findings: unknown[], {...other}): string => encode(_.get(findings[0], 'ProductFields.ProviderName'))
  return {
    subfindingsCodeDesc,
    findingId,
    productname
  }
}
function getSecurityHub(): Record<string, Function> {
  const corresponding_control = (controls: unknown[], finding: unknown) => {
    let out = controls.find(control => _.get(control, 'StandardsControlArn') === _.get(finding, 'ProductFields.StandardsControlArn'))
    return out
  }
  const supportingDocs = (standards: string[] | undefined) => {
    let controls: null | unknown[]
    try {
      if (Array.isArray(standards)) {
        controls = standards.map(standard => _.get(JSON.parse(standard), 'Controls')).flat()
      } else {
        controls = null
      }
    } catch (error) {
      throw `Invalid supporting docs for Security Hub:\nException: ${error}`
    }
    const AWS_CONFIG_MAPPING_FILE = path.resolve(
      __dirname,
      '../data/cwe-nist-mapping.csv'
    );
    const AWS_CONFIG_MAPPING = new AwsConfigMapping(AWS_CONFIG_MAPPING_FILE);
    return {
      controls,
      awsConfigMapping: AWS_CONFIG_MAPPING
    }
  }
  const findingId = (finding: unknown, {controls = null, ...others}: {controls: unknown[] | null}) => {
    let output: string
    let control
    if (controls !== null && (control = corresponding_control(controls, finding)) !== null) {
      output = _.get(control, 'ControlId')
    } else if (_.has(finding, 'ProductFields.ControlId')) { // check if aws
      output = _.get(finding, 'ProductFields.ControlId')
    } else if (_.has(finding, 'ProductFields.RuleId')) { // check if cis
      output = _.get(finding, 'ProductFields.RuleId')
    } else {
      output = _.get(finding, 'GeneratorId').split('/').slice(-1)[0]
    }
    return encode(output)
  }
  const findingImpact = (finding: unknown, {controls = null, ...others}: {controls: unknown[] | null}) => {
    let impact: string | number
    let control
    if (controls !== null && (control = corresponding_control(controls, finding)) !== null) {
      impact = _.get(control, 'SeverityRating')
    } else {
      // severity is required, but can be either 'label' or 'normalized' internally with 'label' being preferred.  other values can be in here too such as the original severity rating.
      impact = _.get(finding, 'Severity.Label') || _.get(finding, 'Severity.Normalized') / 100.0
      // securityhub asff file does not contain accurate severity information by setting things that shouldn't be informational to informational: when additional context, i.e. standards, is not provided, set informational to medium.
      if (typeof impact === 'string' && impact === 'INFORMATIONAL') {
        impact = 'MEDIUM'
      }
    }
    return impact
  }
  const findingNistTag = (finding: unknown, {awsConfigMapping, ...others}: {awsConfigMapping: AwsConfigMapping}) => {
    if (_.get(finding, 'ProductFields.RelatedAWSResources:0/type') !== 'AWS::Config::ConfigRule') {
      return []
    }
    let matches = awsConfigMapping.data.filter((element: AwsConfigMappingItem) => _.get(finding, 'RelatedAWSResources:0/name')?.contains(element.configRuleName))
    return _.uniq(matches.map((rule: AwsConfigMappingItem) => rule.nistId.split('|')).flat()) // Broken until CSV is fixed
  }
  const findingTitle = (finding: unknown, {controls = null, ...others}: {controls: unknown[] | null}) => {
    let control
    if (controls !== null && (control = corresponding_control(controls, finding)) !== null) {
      return encode(_.get(control, 'Title'))
    } else {
      return encode(_.get(finding, 'Title'))
    }
  }
  const productName = (findings: unknown[], {...others}) => {
    // `${_.get(findings[0], 'ProductFields.aws/securityhub/CompanyName')} ${_.get(findings[0], 'ProductFields.aws/securityhub/ProductName')}`
    // not using above due to wanting to provide the standard's name instead
    let standardName: string
    if (_.get(findings[0], 'Types[0]').split('/').slice(-1)[0].replace(/-/gi, ' ').toLowerCase() == _.get(findings[0], 'ProductFields.StandardsControlArn').split('/').slice(-4)[0].replace(/-/gi, ' ').toLowerCase()) {
      standardName = _.get(findings[0], 'Types[0]').split('/').slice(-1)[0].replace(/-/gi, ' ')
    } else {
      standardName = _.get(findings[0], 'ProductFields.StandardsControlArn').split('/').slice(-4)[0].replace(/-/gi, ' ').split(/\s+/).map((element: string) => {return element.charAt(0).toUpperCase() + element.slice(1)}).join(' ')
    }
    return encode(`${standardName} v${_.get(findings[0], 'ProductFields.StandardsControlArn').split('/').slice(-2)[0]}`)
  }
  return {
    supportingDocs,
    findingId,
    findingImpact,
    findingNistTag,
    findingTitle,
    productName
  }
}

export class ASFFMapper extends BaseConverter {
  securityhubStandardsJsonArray: string[] | null;
  meta: Record<string, unknown> | null;
  supportingDocs: Map<RegExp, Record<string, Record<string, unknown>>>;
  mappings: MappedTransform<ExecJSON.Execution, ILookupPath> = {
    platform: {
      name: 'Heimdall Tools',
      release: HeimdallToolsVersion,
      target_id: ''
    },
    version: HeimdallToolsVersion,
    statistics: {
      duration: null
    },
    profiles: [
      {
        name: {
          transformer: () => {
            return _.get(this.meta, 'name') as string || 'AWS Security Finding Format';
          }
        },
        version: '',
        title: {
          transformer: () => {
            return _.get(this.meta, 'title') as string || 'ASFF Findings';
          }
        },
        maintainer: null,
        summary: '',
        license: null,
        copyright: null,
        copyright_email: null,
        supports: [],
        attributes: [],
        depends: [],
        groups: [],
        status: 'loaded',
        controls: [
          {
            path: 'Findings',
            key: 'id',
            arrayTransformer: this.consolidate,
            id: {
              transformer: (finding: unknown): string => this.externalProductHandler(_.get(finding, 'ProductArn'), finding, 'findingId', encode(_.get(finding, 'GeneratorId')))
            },
            title: {
              transformer: (finding: unknown) => this.externalProductHandler(_.get(finding, 'ProductArn'), finding, 'findingTitle', encode(_.get(finding, 'Title')))
            },
            desc: {path: 'Description', transformer: (input: unknown) => encode(input as string)},
            impact: {
              transformer: (finding: unknown) => {
                // There can be findings listed that are intentionally ignored due to the underlying control being superceded by a control from a different standard
                let impact: string | number;
                if (_.get(finding, 'Workflow.Status') === 'SUPPRESSED') {
                  impact = 'INFORMATIONAL'
                } else {
                  // Severity is required, but can be either 'label' or 'normalized' internally with 'label' being preferred.  other values can be in here too such as the original severity rating.
                  const defaultFunc = () => _.get(finding, 'Severity.Label') ? _.get(finding, 'Severity.Label') : _.get(finding, 'Severity.Normalized') / 100.0;
                  impact = this.externalProductHandler(_.get(finding, 'ProductArn'), finding, 'findingImpact', defaultFunc)
                }
                return typeof impact === 'string' ? IMPACT_MAPPING.get(impact) || 0 : impact
              }
            },
            tags: {
              nist: {
                transformer: (finding: unknown) => {
                  let tags = this.externalProductHandler(_.get(finding, 'ProductArn') as string, finding, 'findingNistTag', {}) as string[];
                  if (tags.length === 0) {
                    return DEFAULT_NIST_TAG
                  } else {
                    return tags
                  }
                },
              }
            },
            descriptions: [
              {
                data: {
                  path: 'Remediation.Recommendation', transformer: (input: unknown) => {
                    let data: string[] = []
                    data.push(_.get(input, 'Text'))
                    data.push(_.get(input, 'Url'))
                    return data.join('\n')
                  }
                },
                label: 'fix'
              }
            ],
            refs: [
              {
                url: {
                  path: 'SourceUrl',
                  transformer: (input: unknown) => input === '' ? undefined : input as string
                }
              }
            ],
            source_location: {},
            code: '',
            results: [
              {
                status: {
                  transformer: (finding: unknown) => {
                    if (_.has(finding, 'Compliance.Status')) {
                      switch (_.get(finding, 'Compliance.Status')) {
                        case 'PASSED':
                          return ExecJSON.ControlResultStatus.Passed
                        case 'WARNING':
                          return ExecJSON.ControlResultStatus.Skipped
                        case 'FAILED':
                          return ExecJSON.ControlResultStatus.Failed
                        case 'NOT_AVAILABLE':
                          // primary meaning is that the check could not be performed due to a service outage or API error, but it's also overloaded to mean NOT_APPLICABLE so technically 'skipped' or 'error' could be applicable, but AWS seems to do the equivalent of skipped
                          return ExecJSON.ControlResultStatus.Skipped
                        default:
                          // not a valid value for the status enum
                          return ExecJSON.ControlResultStatus.Error
                      }
                    } else {
                      // if no compliance status is provided which is a weird but possible case, then skip
                      return ExecJSON.ControlResultStatus.Skipped
                    }
                  }
                },
                code_desc: {
                  transformer: (finding: unknown): string => {
                    let output = this.externalProductHandler(_.get(finding, 'ProductArn'), finding, 'subfindingsCodeDesc', '')
                    if (output !== '') {
                      output += '; '
                    }
                    output += `Resources: [${_.get(finding, 'Resources').map((resource: unknown) => {
                      let hash = `Type: ${encode(_.get(resource, 'Type'))}, Id: ${encode(_.get(resource, 'Id'))}`
                      if (_.has(resource, 'Partition')) {
                        hash += `, Partition: ${encode(_.get(resource, 'Partition'))}`
                      }
                      if (_.has(resource, 'Region')) {
                        hash += `, Region: ${encode(_.get(resource, 'Region'))}`
                      }
                      return hash
                    }).join(', ')
                      }]`
                    return output
                  }
                },
                message: {
                  transformer: (finding: unknown) => {
                    let statusReason = this.statusReason(finding)
                    switch (_.get(finding, 'Compliance.Status')) {
                      case undefined: // Possible for Compliance.Status to not be there, in which case it's a skip_message
                        return undefined
                      case 'PASSED':
                        return statusReason
                      case 'WARNING':
                        return undefined
                      case 'FAILED':
                        return statusReason
                      case 'NOT_AVAILABLE':
                        return undefined
                      default:
                        return statusReason
                    }
                  }
                },
                skip_message: {
                  transformer: (finding: unknown) => {
                    let statusReason = this.statusReason(finding)
                    switch (_.get(finding, 'Compliance.Status')) {
                      case undefined: // Possible for Compliance.Status to not be there, in which case it's a skip_message
                        return statusReason
                      case 'PASSED':
                        return undefined
                      case 'WARNING':
                        return statusReason
                      case 'FAILED':
                        return undefined
                      case 'NOT_AVAILABLE':
                        // primary meaning is that the check could not be performed due to a service outage or API error, but it's also overloaded to mean NOT_APPLICABLE so technically 'skipped' or 'error' could be applicable, but AWS seems to do the equivalent of skipped
                        return statusReason
                      default:
                        return undefined
                    }
                  }
                },
                start_time: {transformer: (finding: unknown) => _.get(finding, 'LastObservedAt') || _.get(finding, 'UpdatedAt')},
              }
            ]
          }
        ],
        sha256: ''
      }
    ]
  };
  statusReason(finding: unknown): string | undefined {
    return _.get(finding, 'Compliance.StatusReasons')?.map((reason: Record<string, string>) => Object.entries(reason).map(([key, value]: [string, string]) => {return `${encode(key)}: ${encode(value)}`})).flat().join('\n')
  }
  externalProductHandler(product: string | RegExp, data: unknown, func: string, defaultVal: unknown) {
    let arn = null
    let mapping: Record<string, Function> | undefined
    if ((product instanceof RegExp || (arn = Array.from(PRODUCT_ARN_MAPPING.keys()).find(regex => regex.test(product)))) && (mapping = PRODUCT_ARN_MAPPING.get(arn || product as RegExp)) !== undefined && func in mapping) {
      let keywords: Record<string, unknown> = {}
      if (this.supportingDocs.has(arn || product as RegExp)) {
        keywords = {...this.supportingDocs.get(arn || product as RegExp)}
      }
      return _.get(PRODUCT_ARN_MAPPING.get(arn || product as RegExp), func)?.apply(this, [data, keywords])
    } else {
      if (typeof defaultVal === 'function') {
        return defaultVal()
      } else {
        return defaultVal
      }
    }
  }
  consolidate(input: unknown[], file: unknown) {
    let allFindings = _.get(file, 'Findings')
    // Group subfindings by ASFF Product ARN and HDF ID
    let productGroups: Map<RegExp, Map<string, Array<Array<unknown>>>> = new Map<RegExp, Map<string, Array<Array<unknown>>>>()
    input.forEach((item, index) => {
      let arn = Array.from(PRODUCT_ARN_MAPPING.keys()).find(regex => _.get(allFindings[index], 'ProductArn').match(regex))
      if (arn === undefined) {
        let productInfo = _.get(allFindings[index], 'ProductArn').split(':').slice(-1)[0]
        arn = new RegExp(`arn:.+:securityhub:.+:.*:product/${productInfo.split('/')[1]}/${productInfo.split('/')[2]}`)
      }
      if (!productGroups.has(arn)) {
        productGroups.set(arn, new Map<string, Array<Array<unknown>>>())
      }
      if (!productGroups.get(arn)?.has(_.get(item, 'id'))) {
        productGroups.get(arn)?.set(_.get(item, 'id'), [])
      }
      productGroups.get(arn)?.get(_.get(item, 'id'))?.push([item, allFindings[index]])
    })

    let output: ExecJSON.Control[] = []
    productGroups.forEach((idGroups, product) => {
      idGroups.forEach((data, id) => {
        let group = data.map(d => d[0])
        let findings = data.map(d => d[1])

        let productInfo = _.get(findings[0], 'ProductArn').split(':').slice(-1)[0].split('/')
        let productName = this.externalProductHandler(product, findings, 'productName', encode(`${productInfo[1]}/${productInfo[2]}`))

        let item: ExecJSON.Control = {
          // Add productName to ID if any ID's are the same across products
          id: Array.from(new Map([...productGroups].filter(([pg, key]) => pg !== product)).values()).find((ig) => id in Array.from(ig.keys())) !== undefined ? `[${productName}] ${id}` : id,
          title: `${productName}: ${[... new Set(group.map(d => _.get(d, 'title')))].join(';')}`,
          tags: {
            nist: [... new Set(group.map(d => _.get(d, 'tags.nist')).flat())],
          },
          impact: Math.max(...group.map(d => _.get(d, 'impact'))),
          desc: this.externalProductHandler(product, group, 'desc', [... new Set(group.map(d => _.get(d, 'desc')))].join('\n')),
          descriptions: [... new Set(group.map(d => _.get(d, 'descriptions')).flat().filter(element => element !== null && element !== undefined && element !== {}))],
          refs: [... new Set(group.map(d => _.get(d, 'refs')).flat().filter(element => element !== null && element !== undefined && element !== {}))],
          source_location: {},
          code: JSON.stringify({Findings: findings}, null, 2),
          results: [... new Set(group.map(d => _.get(d, 'results')).flat())]
        }
        output.push(item)
      })
    })
    return output
  }
  constructor(
    asffJson: string,
    securityhubStandardsJsonArray: null | string[] = null,
    meta: null | Record<string, unknown> = null
  ) {
    super(fixFileInput(asffJson));
    this.securityhubStandardsJsonArray = securityhubStandardsJsonArray;
    this.meta = meta;
    this.supportingDocs = new Map<RegExp, Record<string, Record<string, unknown>>>()
    let map = PRODUCT_ARN_MAPPING.get(SECURITYHUB_REGEX)
    if (map) {
      this.supportingDocs.set(SECURITYHUB_REGEX, _.get(map, 'supportingDocs')(this.securityhubStandardsJsonArray))
    }
  }
  setMappings(
    customMappings: MappedTransform<ExecJSON.Execution, ILookupPath>
  ): void {
    super.setMappings(customMappings);
  }
}
