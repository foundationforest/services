// Every error code an answer gives, as `{ "error": "<code>" }`: README.md's Its API names each.

export const CODES = ['bad_words', 'bad_point', 'bad_country', 'not_found', 'get_only', 'failed'] as const
export type Code = (typeof CODES)[number]
