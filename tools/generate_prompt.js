const fs = require('fs');

const csvLines = fs.readFileSync('tools/GooglePlay_IAP_Import.csv', 'utf8').trim().split('\n');
let markdownTable = '| Product ID | Name | Description | Price (USD) |\n| :--- | :--- | :--- | :--- |\n';

for (let i = 1; i < csvLines.length; i++) {
  const rowStr = csvLines[i];
  if (!rowStr) continue;
  
  // Format: Product ID,Published State,Purchase Type,Auto Translate,Locale; Title; Description,Auto Fill Prices,Price
  const firstSplit = rowStr.split(',published');
  if (firstSplit.length < 2) continue;
  const productId = firstSplit[0];
  
  // Extract Locale; Title; Description block
  const localeBlockMatch = rowStr.match(/en_US; ([^;]+); ([^,]+)/);
  if (!localeBlockMatch) continue;
  const name = localeBlockMatch[1].trim();
  const desc = localeBlockMatch[2].trim();
  
  // Extract price (last item separated by comma)
  const priceMicrosMatch = rowStr.match(/true,(\d+)$/);
  if (!priceMicrosMatch) continue;
  const priceDollars = (parseInt(priceMicrosMatch[1], 10) / 1000000).toFixed(2);
  
  markdownTable += `| \`${productId}\` | ${name} | ${desc} | ${priceDollars} |\n`;
}

const promptTemplate = `# Google Play Console Automator

**AGENT INSTRUCTIONS**
You are a Computer Control AI. Your task is to accurately populate a list of exactly 30 In-App Purchase products inside the Google Play Console. You must use the mouse and keyboard to navigate the UI, create the products iteratively, and save/activate them. 

## Target Environment
- **URL**: \`https://play.google.com/console/\`
- **App**: Check that you are inside the specific app dashboard ("Mystic Motors" or "Zenith TD").
- **Navigation Path**: Look at the left sidebar menu. Navigate to **Monetize > Products > One-time products**.

## Step-by-Step Flow (For Each Item)
1. Inside the "One-time products" page, click the **Create product** button.
2. Fill the **Product ID** field exactly as provided in the list below.
3. Fill the **Product details > Name** field.
4. Fill the **Product details > Description** field. 
5. Scroll down to pricing. Click **Set Price**.
6. In the price field, type the exact numerical USD value provided below (e.g., \`4.99\`). Click **Apply** or **Update**.
7. *Handling Random/Variable Fields*:
   - If prompted for a **Tax Category**, leave it as the Default (or "Software").
   - If asked about "Age Rating" or "Target Audience" within this form, ignore it (IAP does not carry its own age rating). 
8. Click **Save** in the bottom right corner.
9. Click **Activate** (usually top right or immediately after saving) so the state changes from 'Inactive' to 'Active'. 
10. Navigate back to **One-time products** and repeat for the next item.

---

## Data Payload (The 30 Items)

${markdownTable}

---

**CRITICAL GUIDELINES FOR THE AGENT:**
- Do not hallucinate fields.
- If you encounter a popup stating "Default Tax category", just click "Confirm" or select "Software". Ensure all pricing overrides are applied logically based on standard USD conversion.
- After saving a product, always ensure it is moved to the **Active** state.
- Proceed sequentially. If you skip one, go back. You must finish all 30 items or explicitly explain to the user where you got stuck.`;

const targetPath = '/Users/christianwbrown/.gemini/antigravity/brain/0d3f7e11-7014-435f-9916-f49b5831af05/artifacts/computer_control_mcp_prompt.md';
// Ensure artifacts directory exists
const dir = '/Users/christianwbrown/.gemini/antigravity/brain/0d3f7e11-7014-435f-9916-f49b5831af05/artifacts';
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(targetPath, promptTemplate);
console.log('Artifact rewritten successfully to artifacts folder.');
