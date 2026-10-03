import assert from 'node:assert/strict'
import {describe, test} from 'node:test'
import {
  BAND_LABELS,
  bandFor,
  PARAMS,
  STARTING_HP,
  STARTING_WARDS,
} from './params.ts'
import {dailySeed, rollIndex, rollInt, rollPercent, runNonce} from './rng.ts'

const BANDS = [0, 1, 2, 3, 4] as const
const ADJACENT = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
] as const

describe('bandFor', () => {
  test('maps depths to bands at every boundary', () => {
    const cases: [number, number][] = [
      [1, 0],
      [10, 0],
      [11, 1],
      [20, 1],
      [21, 2],
      [30, 2],
      [31, 3],
      [40, 3],
      [41, 4],
      [100, 4],
    ]
    for (const [depth, band] of cases) {
      assert.equal(bandFor(depth), band, `depth ${depth}`)
    }
  })

  test('never decreases as depth increases', () => {
    let prev = bandFor(1)
    for (let depth = 2; depth <= 200; depth++) {
      const band = bandFor(depth)
      assert.ok(band >= prev, `band dropped at depth ${depth}`)
      prev = band
    }
  })
})

describe('PARAMS shape', () => {
  test('every table has one entry per band', () => {
    assert.equal(BAND_LABELS.length, BANDS.length)
    assert.equal(PARAMS.mix.length, BANDS.length)
    assert.equal(PARAMS.hazardPresent.length, BANDS.length)
    assert.equal(PARAMS.dmg.length, BANDS.length)
    assert.equal(PARAMS.treasure.length, BANDS.length)
    assert.equal(PARAMS.gambleBonus.length, BANDS.length)
    assert.equal(PARAMS.bandEnds.length, BANDS.length - 1)
  })

  test('encounter mix sums to 100% in every band', () => {
    for (const band of BANDS) {
      const {treasure, hazard, gamble} = PARAMS.mix[band]
      assert.equal(treasure + hazard + gamble, 100, `band ${band + 1}`)
    }
  })

  test('hazards get more common and more often real with depth', () => {
    for (const [prev, next] of ADJACENT) {
      assert.ok(PARAMS.mix[next].hazard >= PARAMS.mix[prev].hazard)
      assert.ok(PARAMS.hazardPresent[next] >= PARAMS.hazardPresent[prev])
    }
  })

  test('treasure and gamble payouts grow with depth', () => {
    for (const [prev, next] of ADJACENT) {
      assert.ok(PARAMS.treasure[next][0] >= PARAMS.treasure[prev][0])
      assert.ok(PARAMS.treasure[next][1] >= PARAMS.treasure[prev][1])
      assert.ok(PARAMS.gambleBonus[next][0] >= PARAMS.gambleBonus[prev][0])
      assert.ok(PARAMS.gambleBonus[next][1] >= PARAMS.gambleBonus[prev][1])
    }
  })
})

describe('damage table', () => {
  test('matches the agreed values per band', () => {
    assert.deepEqual(
      PARAMS.dmg.map(([lo, hi]) => [lo, hi]),
      [
        [1, 2],
        [1, 3],
        [1, 4],
        [2, 4],
        [3, 4],
      ],
    )
  })

  test('is a valid range: at least 1, lo <= hi', () => {
    for (const band of BANDS) {
      const [lo, hi] = PARAMS.dmg[band]
      assert.ok(lo >= 1, `band ${band + 1} can deal 0 damage`)
      assert.ok(lo <= hi, `band ${band + 1} has lo > hi`)
    }
  })

  test('no single hit can kill a full-health player', () => {
    for (const band of BANDS) {
      assert.ok(
        PARAMS.dmg[band][1] < STARTING_HP,
        `band ${band + 1} max damage ${PARAMS.dmg[band][1]} >= ${STARTING_HP} HP`,
      )
    }
  })

  test('floor and ceiling never fall as you go deeper', () => {
    for (const [prev, next] of ADJACENT) {
      assert.ok(PARAMS.dmg[next][0] >= PARAMS.dmg[prev][0])
      assert.ok(PARAMS.dmg[next][1] >= PARAMS.dmg[prev][1])
    }
  })

  test('it takes at least 3 hits to kill in band 1, at least 2 in every band', () => {
    const minHitsToKill = (band: 0 | 1 | 2 | 3 | 4) =>
      Math.ceil(STARTING_HP / PARAMS.dmg[band][1])
    assert.ok(minHitsToKill(0) >= 3)
    for (const band of BANDS) assert.ok(minHitsToKill(band) >= 2)
  })

  test('expected damage per step rises with every band', () => {
    // hazard hit chance + failed-gamble chance, times average damage; wards ignored.
    const expectedPerStep = (band: 0 | 1 | 2 | 3 | 4) => {
      const [lo, hi] = PARAMS.dmg[band]
      const avg = (lo + hi) / 2
      const hazard =
        (PARAMS.mix[band].hazard / 100) * (PARAMS.hazardPresent[band] / 100)
      const gamble =
        (PARAMS.mix[band].gamble / 100) * (1 - PARAMS.gambleSuccess / 100)
      return (hazard + gamble) * avg
    }
    for (const [prev, next] of ADJACENT) {
      assert.ok(
        expectedPerStep(next) > expectedPerStep(prev),
        `band ${next + 1} is not more dangerous than band ${prev + 1}`,
      )
    }
    // Spot-check the figures from the balancing discussion.
    assert.ok(Math.abs(expectedPerStep(0) - 0.2625) < 1e-9)
    assert.ok(Math.abs(expectedPerStep(4) - 1.075) < 0.001)
  })
})

describe('starting resources', () => {
  test('player starts with 5 HP and 3 wards', () => {
    assert.equal(STARTING_HP, 5)
    assert.equal(STARTING_WARDS, 3)
  })
})

describe('rolls', () => {
  const seed = dailySeed('t2_test', '2026-01-01')

  test('damage rolls stay inside each band range and hit every value', () => {
    for (const band of BANDS) {
      const [lo, hi] = PARAMS.dmg[band]
      const seen = new Set<number>()
      for (let depth = 1; depth <= 2000; depth++) {
        const dmg = rollInt(seed, depth, 'dmg', lo, hi)
        assert.ok(dmg >= lo && dmg <= hi, `band ${band + 1}: rolled ${dmg}`)
        seen.add(dmg)
      }
      assert.equal(seen.size, hi - lo + 1, `band ${band + 1} missed a value`)
    }
  })

  test('damage averages near the middle of the range', () => {
    for (const band of BANDS) {
      const [lo, hi] = PARAMS.dmg[band]
      let total = 0
      const n = 4000
      for (let depth = 1; depth <= n; depth++) {
        total += rollInt(seed, depth, 'dmg', lo, hi)
      }
      assert.ok(
        Math.abs(total / n - (lo + hi) / 2) < 0.1,
        `band ${band + 1} avg ${total / n}`,
      )
    }
  })

  test('same seed, depth and channel always give the same roll', () => {
    assert.equal(rollInt(seed, 7, 'dmg', 1, 4), rollInt(seed, 7, 'dmg', 1, 4))
    assert.equal(rollPercent(seed, 7, 'type'), rollPercent(seed, 7, 'type'))
  })

  test('different run nonces give different encounter sequences', () => {
    const a = `${seed}:${runNonce()}`
    const b = `${seed}:${runNonce()}`
    assert.notEqual(a, b)
    const seqA = Array.from({length: 30}, (_, i) =>
      rollPercent(a, i + 1, 'type'),
    )
    const seqB = Array.from({length: 30}, (_, i) =>
      rollPercent(b, i + 1, 'type'),
    )
    assert.notDeepEqual(seqA, seqB)
  })

  test('percent rolls are in [0, 100) and index rolls in range', () => {
    for (let depth = 1; depth <= 1000; depth++) {
      const p = rollPercent(seed, depth, 'type')
      assert.ok(p >= 0 && p < 100)
      const i = rollIndex(seed, depth, 'telegraph', 6)
      assert.ok(Number.isInteger(i) && i >= 0 && i < 6)
    }
  })

  test('encounter type frequencies follow the band mix', () => {
    for (const band of BANDS) {
      const {treasure, hazard} = PARAMS.mix[band]
      const n = 10000
      let t = 0
      let h = 0
      for (let depth = 1; depth <= n; depth++) {
        const r = rollPercent(seed, depth, `type${band}`)
        if (r < treasure) t++
        else if (r < treasure + hazard) h++
      }
      assert.ok(
        Math.abs((t / n) * 100 - treasure) < 2,
        `band ${band + 1} treasure`,
      )
      assert.ok(Math.abs((h / n) * 100 - hazard) < 2, `band ${band + 1} hazard`)
    }
  })
})
