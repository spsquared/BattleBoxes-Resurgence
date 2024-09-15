/**
 * Look up the name of an enumeration based on the value
 */
export function reverse_enum(enumeration: any, v: any): string {
    for (const k in enumeration) if (enumeration[k] === v) return k;
    return v;
}
/**
 * Check if a value is in an enumeration
 */
export function is_in_enum(v: any, enumeration: any): boolean {
    for (const k in enumeration) if (enumeration[k] === v) return true;
    return false;
}