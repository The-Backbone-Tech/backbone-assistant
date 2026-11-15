/** Creation and rename share the existing display-name rules. Names never choose a storage path. */
export function validProjectName(value:unknown):value is string {
  return typeof value==='string'&&!!value.trim()&&value.length<=1000;
}
