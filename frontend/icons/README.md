# Иконки приложения

Сгенерированы скриптом `tools/make_icons.py` (Pillow), поэтому их всегда можно
пересобрать одной командой:

```bash
pip install pillow
python tools/make_icons.py
```

| Файл | Где используется |
|------|------------------|
| `icon-64.png` | вкладка браузера, мелкие размеры |
| `icon-192.png` | Android, ярлыки (`shortcuts` в манифесте) |
| `icon-512.png` | установка приложения, splash |
| `icon-maskable-512.png` | Android с адаптивной маской (логотип в безопасной зоне) |
| `apple-touch-icon.png` | iOS «На экран Домой» |
