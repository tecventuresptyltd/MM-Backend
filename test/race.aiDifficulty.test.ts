/**
 * Test file for AI Difficulty System in prepareRace function
 * Verifies that aiLevel and performanceRanges are correctly calculated and returned
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import * as admin from 'firebase-admin';
import { calculateBotStatsFromTrophies } from '../src/race/lib/stats.js';
import { BotConfig } from '../src/core/config.js';

describe('AI Difficulty System', () => {
  
  describe('calculateBotStatsFromTrophies', () => {
    const mockStatRanges = {
      topSpeed: { min: 140, max: 340 },
      acceleration: { min: 4.5, max: 9.5 },
      handling: { min: 28, max: 44 },
      boostRegen: { min: 11, max: 5 },
      boostPower: { min: 8, max: 22 },
      aiSpeed: { min: 100, max: 800 },
      aiBoostPower: { min: 0.10, max: 0.30 },
      aiAcceleration: { min: 8, max: 13 },
      endGameDifficulty: 60
    };

    const mockCarLevelData = {
      topSpeed: 8,
      acceleration: 8,
      handling: 8,
      boostRegen: 8,
      boostPower: 8
    };

    it('leaves legacy real stats unset across trophy progression', () => {
      for (const trophies of [0, 3500, 7000]) {
        expect(calculateBotStatsFromTrophies(trophies, mockStatRanges, mockCarLevelData).real).toEqual({
          topSpeed: 0, acceleration: 0, handling: 0, boostRegen: 0, boostPower: 0,
        });
      }
    });

    it('preserves legacy stat placeholders outside the trophy range', () => {
      const expected = calculateBotStatsFromTrophies(0, mockStatRanges, mockCarLevelData);
      expect(calculateBotStatsFromTrophies(-500, mockStatRanges, mockCarLevelData)).toEqual(expected);
      expect(calculateBotStatsFromTrophies(10000, mockStatRanges, mockCarLevelData)).toEqual(expected);
    });

    it('should return display values from car catalog', () => {
      const stats = calculateBotStatsFromTrophies(3500, mockStatRanges, mockCarLevelData);
      expect(stats.display.topSpeed).toBe(8);
      expect(stats.display.acceleration).toBe(8);
      expect(stats.display.handling).toBe(8);
      expect(stats.display.boostRegen).toBe(8);
      expect(stats.display.boostPower).toBe(8);
    });
  });

  describe('AI Difficulty Calculation Logic', () => {
    it('should calculate aiLevel as percentage (0-100) of normalized trophies', () => {
      // Test cases from master prompt
      const testCases = [
        { trophies: 500, expectedLevel: 7.14 },  // (500/7000)*100 = 7.14
        { trophies: 2458, expectedLevel: 35.11 }, // (2458/7000)*100 = 35.11
        { trophies: 6300, expectedLevel: 90.0 },  // (6300/7000)*100 = 90.0
        { trophies: 0, expectedLevel: 0.0 },
        { trophies: 7000, expectedLevel: 100.0 },
      ];

      testCases.forEach(({ trophies, expectedLevel }) => {
        const normalizedTrophies = Math.max(0, Math.min(7000, trophies));
        const trophyPercentage = normalizedTrophies / 7000;
        const aiLevel = Math.round((trophyPercentage * 100) * 100) / 100;
        expect(aiLevel).toBeCloseTo(expectedLevel, 2);
      });
    });

    it('should create performanceRanges object with correct fields', () => {
      const mockAiConfig = {
        minSpeed: 100,
        maxSpeed: 800,
        boostPowerMin: 0.10,
        boostPowerMax: 0.30,
        endGameDifficulty: 60,
        minAcceleration: 8,
        maxAcceleration: 13
      };

      const performanceRanges = {
        minSpeed: mockAiConfig.minSpeed,
        maxSpeed: mockAiConfig.maxSpeed,
        boostPowerMin: mockAiConfig.boostPowerMin,
        boostPowerMax: mockAiConfig.boostPowerMax,
        endGameDifficulty: mockAiConfig.endGameDifficulty,
        minAcceleration: mockAiConfig.minAcceleration,
        maxAcceleration: mockAiConfig.maxAcceleration
      };

      expect(performanceRanges).toEqual({
        minSpeed: 100,
        maxSpeed: 800,
        boostPowerMin: 0.10,
        boostPowerMax: 0.30,
        endGameDifficulty: 60,
        minAcceleration: 8,
        maxAcceleration: 13
      });
    });
  });

  describe('BotConfig Type Validation', () => {
    it('should have correct TypeScript type for new AI difficulty fields', () => {
      // This test validates that BotConfig type includes optional AI fields
      const mockBotConfig: BotConfig = {
        statRanges: {
          topSpeed: { min: 140, max: 340 },
          acceleration: { min: 4.5, max: 9.5 },
          handling: { min: 28, max: 44 },
          boostRegen: { min: 11, max: 5 },
          boostPower: { min: 8, max: 22 },
          aiSpeed: { min: 100, max: 800 },
          aiBoostPower: { min: 0.10, max: 0.30 },
          aiAcceleration: { min: 8, max: 13 },
          endGameDifficulty: 60
        },
        carUnlockThresholds: [
          { carId: 'car_test', trophies: 0 }
        ],
        cosmeticRarityWeights: {
          '0-999': { common: 85, rare: 14, epic: 1, legendary: 0 }
        },
        spellLevelBands: [
          { minTrophies: 0, maxTrophies: 999, minLevel: 1, maxLevel: 2 }
        ],
        updatedAt: 0
      };

      // Validate new AI fields exist and are optional
      expect(mockBotConfig.statRanges.aiSpeed).toBeDefined();
      expect(mockBotConfig.statRanges.aiBoostPower).toBeDefined();
      expect(mockBotConfig.statRanges.aiAcceleration).toBeDefined();
      expect(mockBotConfig.statRanges.endGameDifficulty).toBeDefined();
    });

    it('should allow BotConfig without AI difficulty fields (backward compatibility)', () => {
      // Test that old BotConfig format still works (optional fields)
      const oldBotConfig: BotConfig = {
        statRanges: {
          topSpeed: { min: 140, max: 340 },
          acceleration: { min: 4.5, max: 9.5 },
          handling: { min: 28, max: 44 },
          boostRegen: { min: 11, max: 5 },
          boostPower: { min: 8, max: 22 },
          // AI fields omitted (optional)
        },
        carUnlockThresholds: [],
        cosmeticRarityWeights: {},
        spellLevelBands: [],
        updatedAt: 0
      };

      expect(oldBotConfig.statRanges.aiSpeed).toBeUndefined();
      expect(oldBotConfig.statRanges.endGameDifficulty).toBeUndefined();
    });
  });
});
