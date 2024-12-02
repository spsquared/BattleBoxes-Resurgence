# BattleBoxes-Resurgence
BattleBoxes Multiplayer, but with AI bots and Not Spaghetti™ code!



**Herebe unfinished documentation!!!!**

Making maps:
- Maps are made using [Tiled](https://www.mapeditor.org/) v1.11.0 (other versions may work), in orthagonal layout and in "Right Down" order (both map and tileset)
- Tilesets can be of any size, as long as the tiles are square
  - Collisions are made using Tiled's built-in "Collision Editor" tool
  - Each collision MUST be a rectangular collision with an angle of 0 have a "friction" custom property that defines the coefficient of friction (usually 1)
- Assets must be exported as `json` files
  - Tileset goes to `tileset.json` under `game-resources/`
  - Maps go to `mapname.json` under `game-resources/maps` (`mapname` is the name of the map, no dots in name please!)
  - Tileset image must be stored under `game-resources/textures/tileset.png` (or any other format browsers can load)
- Names of "above" layers (map layers that render on top of other entities) MUST start with "A" (case insensitive)
- Name of spawnpoints layer (defines spawnpoints for players and loot boxes) MUST be "Spawns" (case insensitive)
- Spawnpoints are defined by the custom property "spawnpoint"
  - There must be at least `config.gameMaxPlayers` possible player spawnpoints (custom property value is "player")
  - Lootbox spawnpoints can be random ("lootbox="), positive random ("lootbox=+"), negative random ("lootbox=-"), or the id of the lootbox ("lootbox=`{id}`", where `{id}` is replaced by the id)

Random things that happen to be important:
* The `DATABASE_URL` environment variable must be set by default. To use a local file database (not recommended, prone to corruption!), disable it in the configuration file (/config/config.json).
* For non-local hosting, the CORS policies and Content Security Policy must be updated to include your domains. Server/client domains can be updated through `config.json` and `.env` files, however CSP must be updated in `index.html` of the client.