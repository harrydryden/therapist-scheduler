/**
 * Shared word list for voucher display codes.
 *
 * 256 short, memorable, positive words used to derive human-readable
 * "what3words-style" display codes from HMAC signatures.
 *
 * IMPORTANT: This is the single source of truth. Both frontend (useVoucher.ts)
 * and backend (voucher-token.ts) must import from here. Never duplicate this list.
 */
// prettier-ignore
export const VOUCHER_WORD_LIST: readonly string[] = [
  'amber',  'apple',  'arrow',  'aspen',  'atlas',  'azure',  'badge',  'baker',
  'basil',  'beach',  'berry',  'birch',  'bliss',  'bloom',  'blush',  'bonus',
  'brave',  'brook',  'brush',  'cabin',  'candy',  'carve',  'cedar',  'charm',
  'chase',  'chess',  'chime',  'chord',  'cider',  'cinch',  'clam',   'clay',
  'cliff',  'climb',  'cloak',  'cloud',  'coach',  'coast',  'coral',  'comet',
  'crane',  'creek',  'crest',  'crisp',  'crown',  'crush',  'curve',  'daisy',
  'dance',  'darts',  'dawn',   'delta',  'denim',  'depth',  'dew',    'digit',
  'diver',  'dock',   'dove',   'draft',  'dream',  'drift',  'drum',   'dune',
  'eagle',  'earth',  'easel',  'ember',  'epoch',  'fable',  'feast',  'fern',
  'field',  'finch',  'flame',  'flask',  'fleet',  'flint',  'flora',  'focus',
  'forge',  'fox',    'frost',  'fruit',  'gale',   'garnet', 'gaze',   'gem',
  'gentle', 'glade',  'gleam',  'glide',  'globe',  'glow',   'goose',  'grace',
  'grain',  'grand',  'grape',  'grove',  'guide',  'haiku',  'haven',  'hawk',
  'hazel',  'heart',  'heath',  'hedge',  'hero',   'heron',  'holly',  'honey',
  'horizon','hue',    'ivory',  'ivy',    'jade',   'jasper', 'jewel',  'jolly',
  'jump',   'kale',   'keel',   'keen',   'kelp',   'kite',   'knoll',  'lace',
  'lake',   'lark',   'laurel', 'leaf',   'ledge',  'light',  'lilac',  'lily',
  'linen',  'lively', 'lodge',  'lotus',  'lucky',  'lunar',  'lush',   'lyric',
  'maple',  'marsh',  'mason',  'meadow', 'merry',  'mirth',  'misty',  'moon',
  'moss',   'muse',   'noble',  'north',  'novel',  'nutmeg', 'oasis',  'ocean',
  'olive',  'opal',   'orbit',  'otter',  'owl',    'palm',   'patch',  'path',
  'peach',  'pearl',  'pebble', 'perch',  'petal',  'pilot',  'pine',   'pixel',
  'plaid',  'plume',  'poem',   'polar',  'pond',   'poppy',  'port',   'prism',
  'pulse',  'quail',  'quest',  'quiet',  'quilt',  'raven',  'ridge',  'ripple',
  'river',  'robin',  'rose',   'rowan',  'ruby',   'sage',   'sail',   'sand',
  'satin',  'scale',  'scout',  'shell',  'shore',  'silk',   'slate',  'slope',
  'solar',  'spark',  'spice',  'spoke',  'spray',  'spruce', 'star',   'steam',
  'stone',  'storm',  'stork',  'sunny',  'surge',  'swift',  'thorn',  'thyme',
  'tide',   'tiger',  'trail',  'tree',   'tulip',  'twist',  'vale',   'vault',
  'velvet', 'verse',  'vigor',  'vine',   'violet', 'vivid',  'wander', 'wave',
  'wheat',  'willow', 'wind',   'wing',   'winter', 'wren',   'yarn',   'zeal',
  'zenith', 'zephyr', 'cove',   'dusk',   'echo',   'fjord',  'glen',   'haze',
] as const;
