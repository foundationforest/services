// How words are compared, the same in the build and in every answer: accents removed (each letter's
// marks, by Unicode's NFD), lower case, and split on anything that is not a letter or a digit. The
// file's text search (FTS5's unicode61 tokenizer, remove_diacritics 2) splits and folds the same
// way, so a word found there is a word here.

/** The words of `text`, folded. */
export function words(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/** `text` folded to its words, one space between each. */
export const fold = (text: string): string => words(text).join(' ')
