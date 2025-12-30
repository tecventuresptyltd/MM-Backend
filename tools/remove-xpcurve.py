#!/usr/bin/env python3
"""Remove legacy XpCurve catalog entry from seeds"""
import json

# Read the file
with open('seeds/Atul-Final-Seeds/gameDataCatalogs.v3.normalized.json', 'r') as f:
    data = json.load(f)

# Filter out XpCurve entry
original_count = len(data)
data = [item for item in data if item.get('path') != '/GameData/v1/catalogs/XpCurve']
removed_count = original_count - len(data)

# Write back
with open('seeds/Atul-Final-Seeds/gameDataCatalogs.v3.normalized.json', 'w') as f:
    json.dump(data, f, indent=2)

print(f"✅ Removed {removed_count} XpCurve entry")
print(f"📦 {len(data)} catalogs remaining")
