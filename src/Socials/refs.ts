import { db } from "../shared/firestore.js";
import type { LeaderboardMetric } from "./types.js";

export const playerProfileRef = (uid: string) =>
  db.collection("Players").doc(uid).collection("Profile").doc("Profile");

export const playerEconomyRef = (uid: string) =>
  db.collection("Players").doc(uid).collection("Economy").doc("Stats");

export const socialProfileRef = (uid: string) =>
  db.collection("Players").doc(uid).collection("Social").doc("Profile");

export const socialFriendsRef = (uid: string) =>
  db.collection("Players").doc(uid).collection("Social").doc("Friends");

export const socialRequestsRef = (uid: string) =>
  db.collection("Players").doc(uid).collection("Social").doc("Requests");

export const socialBlocksRef = (uid: string) =>
  db.collection("Players").doc(uid).collection("Social").doc("Blocks");

export const leaderboardDocRef = (metric: LeaderboardMetric) =>
  db.collection("GlobalLeaderboard").doc(metric);

export const playerLoadoutRef = (uid: string) =>
  db.collection("Players").doc(uid).collection("Loadouts").doc("Active");

export const playerSpellDecksRef = (uid: string) =>
  db.collection("Players").doc(uid).collection("SpellDecks").doc("Decks");

export const playerSpellLevelsRef = (uid: string) =>
  db.collection("Players").doc(uid).collection("Spells").doc("Levels");
