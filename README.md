# BattleBoxes-Resurgence
BattleBoxes Multiplayer, but with AI bots and Not Spaghetti™ code!



**Herebe unfinished documentation!!!!**

Making maps:
- Maps are made using [Tiled](https://www.mapeditor.org/) v1.11.0, in orthagonal layout and in "Right Down" order (both map and tileset)
- Tilesets can be of any size, as long as the tiles are square
- Assets must be exported as `json` files
  - Tileset goes to `tileset.json` under `game-resources/`
  - Maps go to `mapname.json` under `game-resources/maps` (`mapname` is the name of the map, no dots in name please!)
  - Tileset image must be stored under `game-resources/textures/tileset.png` (or any other format browsers can load)