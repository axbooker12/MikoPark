# Agent headshots

MikoPark shows a photo for each agent when one is available. Use AI-generated headshots of people who
don't exist (never photos of real people without their permission). Adobe Firefly works well and its
images are cleared for commercial use.

## Two ways to add photos

- **One agent at a time:** open the agent's profile (click its name at the top of its chat) and choose
  **Add photo**. The photo is cropped to a square automatically.
- **All at once:** save each image in `web/public/avatars/` using the file name in the table below
  (`.jpg`, `.png` or `.webp`), then restart `npm run dev`. Every agent of that role uses it.

## Settings in Adobe Firefly (Text to Image)

- **Content type:** Photo
- **Aspect ratio:** Square (1:1)
- Generate, pick the best of the four, and download.

Add this style text to the end of every prompt so the set looks consistent:

> professional corporate headshot photograph, head and shoulders, facing the camera, warm confident
> smile, soft natural studio lighting, plain light gray background, sharp focus, photorealistic, 85mm lens

## Prompts

Half of the team is African American; the rest reflect a mix of backgrounds.

| Agent | Save as | Prompt (then add the style text) |
|---|---|---|
| Benson (guide & team lead) | `genny.jpg` | African American man in his 50s, short cropped hair, neatly trimmed beard, charcoal suit jacket and white shirt |
| ContentWriter | `writer.jpg` | African American woman in her 30s, shoulder-length curly hair, navy blazer over a white top |
| DataAnalyst | `analyst.jpg` | African American man in his 30s, short hair, thin-framed glasses, navy sweater over a collared shirt |
| SoftwareEngineer | `engineer.jpg` | African American man in his late 20s, short locs, dark gray sweater over a collared shirt |
| SalesOutreach | `sales.jpg` | African American man in his 40s, short hair, light beard, navy blazer and open-collar shirt |
| LegalCounsel | `legal-counsel.jpg` | African American woman in her 50s, sleek bob haircut, glasses, black suit jacket |
| AlgorithmicMarketingStrategist | `algorithmic-marketing.jpg` | African American woman in her 30s, natural curly hair, charcoal blazer over a fine-knit sweater |
| BrandStrategist | `brand-strategist.jpg` | African American woman in her 40s, hair pulled back in a polished bun, black blazer, small earrings |
| Accountant | `accountant.jpg` | African American man in his 40s, short curly hair, light beard, glasses, gray sweater over a collared shirt |
| ProductManager | `product-manager.jpg` | African American woman in her 30s, long locs, navy blazer |
| ResearchAnalyst | `researcher.jpg` | East Asian woman in her 30s, long straight dark hair, glasses, dark blazer |
| ProductDesigner | `designer.jpg` | Latina woman in her 30s, shoulder-length brown hair, dark V-neck top |
| ProjectManager | `pm.jpg` | white man in his 40s, wavy light-brown hair, short beard, navy sweater over a collared shirt |
| SearchEngineStrategist | `search-strategist.jpg` | South Asian man in his 30s, neatly side-parted dark hair, navy blazer |
| Paralegal | `paralegal.jpg` | white woman in her 30s, straight blonde hair, gray blazer |
| MarketingPlanner | `marketing-planner.jpg` | Latino man in his 30s, short curly dark hair, short beard, dark sweater over a collared shirt |
| DocEditor | `doc-editor.jpg` | white man in his 60s, short gray hair, glasses, gray blazer over a sweater |
| EmailAssistant | `email-assistant.jpg` | East Asian woman in her 20s, straight shoulder-length black hair, dark blazer |
| SlidesAssistant | `slides-assistant.jpg` | Middle Eastern woman in her 30s wearing a navy hijab, navy blazer |
