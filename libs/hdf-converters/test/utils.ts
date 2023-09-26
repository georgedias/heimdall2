import {ExecJSON} from 'inspecjs';
import * as _ from 'lodash';
import {IFindingASFF} from '../src/converters-from-hdf/asff/asff-types';
import * as htmlparser2 from 'htmlparser2';

export function omitVersions(
  input: ExecJSON.Execution
): Partial<ExecJSON.Execution> & {profiles: ExecJSON.Profile} {
  return _.omit(input, [
    'version',
    'platform.release',
    'profiles[0].sha256',
    'profiles[0].version'
  ]) as unknown as Partial<ExecJSON.Execution> & {profiles: ExecJSON.Profile};
}

// Profile information title contains a changing value
export function omitASFFTitle(
  input: Partial<IFindingASFF>[]
): Partial<IFindingASFF>[] {
  return input.map((finding) => _.omit(finding, 'Title'));
}

export function omitASFFTimes(
  input: Partial<IFindingASFF>[]
): Partial<IFindingASFF>[] {
  return input.map((finding) => _.omit(finding, ['UpdatedAt', 'CreatedAt']));
}

export function omitASFFVersions(
  input: Partial<IFindingASFF>[]
): Partial<IFindingASFF>[] {
  return input.map((finding) => {
    if (_.has(finding, 'FindingProviderFields.Types')) {
      const typesArray = _.reject(
        _.get(finding, 'FindingProviderFields.Types') as unknown as string[],
        (type) => _.startsWith(type, 'MITRE/SAF/')
      );
      _.set(finding, 'FindingProviderFields.Types', typesArray);
    }
    return finding;
  });
}

export function omitHDFTimes(
  input: Partial<ExecJSON.Execution> & {profiles: ExecJSON.Profile[]}
) {
  return {
    ...input,
    profiles: input.profiles.map((profile) => {
      return {
        ...profile,
        controls: profile.controls.map((control) => {
          return {
            ...control,
            attestation_data: _.omit(control.attestation_data, 'updated'),
            results: control.results.map((result) => {
              return {
                ..._.omit(result, 'start_time'),
                message: result.message?.replace(/Updated:.*\n/g, '')
              };
            })
          };
        })
      };
    })
  };
}

export function omitCklUuid(input: string) {
  let result = '';
  let omitData = false;
  // console.log(input)
  const parser = new htmlparser2.Parser({
    onopentag: (name) => {
      result += `<${name}>`;
    },
    ontext: (text) => {
      if (!omitData) {
        result += text;
      }
      if (text === 'uuid') {
        omitData = true;
      }
    },
    onclosetag: (name) => {
      result += `</${name}>`;
      if (name === 'SID_DATA') {
        omitData = false;
      }
    }
  },
  {
    lowerCaseTags: false
  });
  parser.write(input);
  parser.end();
  // console.log('---------------------------------------------------------------------------------------------------------------------------------');
  // console.log(result);
//   const istigs = _.get(input.value, 'stigs.istig', []) as unknown as Istig[]
//   return {
//     ...input,
//     value: {
//       ...input.value,
//       stigs: {
//         istig: istigs.map((is) => {
//           return 
//         })
//       }
//     }
//   }  
}
