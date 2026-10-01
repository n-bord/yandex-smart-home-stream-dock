# Яндекс Умный дом [n-bord] для Stream Dock

![Яндекс Умный дом на Stream Dock](./screenshots/cover.png)

<p align="center">
  <a href="https://github.com/n-bord/yandex-smart-home-stream-dock/releases">
    <img src="https://img.shields.io/github/v/release/n-bord/yandex-smart-home-stream-dock?style=flat-square&label=release&color=7C5CFF" alt="GitHub Release">
  </a>
  <a href="https://github.com/n-bord/yandex-smart-home-stream-dock/releases">
    <img src="https://img.shields.io/github/downloads/n-bord/yandex-smart-home-stream-dock/total?style=flat-square&label=downloads&color=34C759" alt="Downloads">
  </a>
  <a href="https://github.com/n-bord/yandex-smart-home-stream-dock/stargazers">
    <img src="https://img.shields.io/github/stars/n-bord/yandex-smart-home-stream-dock?style=flat-square&label=stars&color=F5C542" alt="GitHub Stars">
  </a>
  <a href="https://github.com/n-bord/yandex-smart-home-stream-dock/issues">
    <img src="https://img.shields.io/github/issues/n-bord/yandex-smart-home-stream-dock?style=flat-square&label=issues&color=5DADE2" alt="GitHub Issues">
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS-111827?style=flat-square&logo=apple&logoColor=white" alt="macOS">
  <img src="https://img.shields.io/badge/Windows-planned-6B7280?style=flat-square&logo=windows11&logoColor=white" alt="Windows planned">
  <img src="https://img.shields.io/badge/Stream%20Dock-compatible-7C5CFF?style=flat-square" alt="Stream Dock Compatible">
  <img src="https://img.shields.io/badge/Yandex%20Smart%20Home-unofficial-FFCC00?style=flat-square&labelColor=111827" alt="Unofficial Yandex Smart Home plugin">
</p>

<p align="center">
  <a href="https://github.com/n-bord/yandex-smart-home-stream-dock/releases/latest">
    <img src="https://img.shields.io/badge/СКАЧАТЬ%20ДЛЯ%20macOS-111111?style=for-the-badge&logo=apple&logoColor=white" alt="Скачать для macOS">
  </a>
  <a href="https://boosty.to/nbord">
    <img src="https://img.shields.io/badge/ПОДДЕРЖАТЬ%20НА%20BOOSTY-F15F2C?style=for-the-badge" alt="Поддержать на Boosty">
  </a>
</p>

Неофициальный плагин для управления **Яндекс Умным домом** с устройств **Stream Dock** на **macOS**.

Основная идея проекта — вынести повседневное управление домом на физические кнопки, крутилки и информационные экраны Stream Dock, а для более подробного управления использовать встроенную локальную панель.

**Версия:** `1.0.0`  
**Автор:** [n-bord](https://github.com/n-bord)  
**Репозиторий:** [github.com/n-bord/yandex-smart-home-stream-dock](https://github.com/n-bord/yandex-smart-home-stream-dock)

> **Неофициальный любительский проект.** Проект не связан с компанией Яндекс и сервисом «Умный дом» от Яндекса и не поддерживается ими. Все упомянутые товарные знаки принадлежат их правообладателям.

---

## Главное

- управление устройствами Яндекс Умного дома с **кнопок Stream Dock**;
- управление яркостью, температурой, шторами, вентиляцией, громкостью и другими параметрами с **крутилок**;
- отображение показаний датчиков и краткой сводки на совместимых информационных областях;
- запуск сценариев;
- управление ИК-пультами и телевизорами;
- отдельная локальная панель со всеми комнатами, группами и устройствами;
- история показателей датчиков;
- избранное, статистика, сортировка, скрытие устройств и диагностика;
- светлая и тёмная темы;
- интерфейс строится с учётом `capabilities` конкретного устройства.

---

# Stream Dock — основной функционал

## Как это выглядит на устройстве

![Пример раскладки Stream Dock](./screenshots/stream-dock-layout.png)

Плагин позволяет собрать собственную раскладку: обычные кнопки, информационные плитки и управление параметрами через крутилки могут использоваться одновременно.

## Доступные действия

![Список действий плагина](./screenshots/actions-menu.png)

Набор действий включает управление обычными устройствами, светом, датчиками, шторами, климатом, чайниками, телевизорами, ИК-пультами и сценариями.

| Иконка | Действие | Для чего |
|---|---|---|
| <img src="./com.nbord.yandexsmarthome.streamdock.sdPlugin/static/icons/power.png" width="32"> | **Устройство — Вкл/Выкл** | Питание совместимого устройства |
| <img src="./com.nbord.yandexsmarthome.streamdock.sdPlugin/static/icons/light.png" width="32"> | **Свет — Вкл/Выкл** | Управление лампой или группой света |
| <img src="./com.nbord.yandexsmarthome.streamdock.sdPlugin/static/icons/brightness.png" width="32"> | **Свет — Яркость** | Регулировка яркости крутилкой |
| <img src="./com.nbord.yandexsmarthome.streamdock.sdPlugin/static/icons/light_temp.png" width="32"> | **Свет — Температура** | Регулировка температуры белого света |
| <img src="./com.nbord.yandexsmarthome.streamdock.sdPlugin/static/icons/color.png" width="32"> | **Свет — Цвет / Пресет** | RGB/HSV, белый свет и пресеты |
| <img src="./com.nbord.yandexsmarthome.streamdock.sdPlugin/static/icons/sensor.png" width="32"> | **Датчик — Показание / Показатели** | Температура, влажность, CO₂, PM2.5 и другие данные |
| <img src="./com.nbord.yandexsmarthome.streamdock.sdPlugin/static/icons/curtain.png" width="32"> | **Шторы — Положение** | Изменение положения штор |
| <img src="./com.nbord.yandexsmarthome.streamdock.sdPlugin/static/icons/vacuum.png" width="32"> | **Пылесос — Скорость** | Управление поддерживаемыми параметрами пылесоса |
| <img src="./com.nbord.yandexsmarthome.streamdock.sdPlugin/static/icons/fan.png" width="32"> | **Очиститель / Вентилятор** | Скорость, режим и доступные параметры |
| <img src="./com.nbord.yandexsmarthome.streamdock.sdPlugin/static/icons/kettle.png" width="32"> | **Чайник — Температура** | Изменение целевой температуры |
| <img src="./com.nbord.yandexsmarthome.streamdock.sdPlugin/static/icons/tv.png" width="32"> | **Телевизор / ИК** | Громкость, каналы и поддерживаемые команды |
| <img src="./com.nbord.yandexsmarthome.streamdock.sdPlugin/static/icons/ir.png" width="32"> | **ИК / Пульт — Команда** | Команды устройств Яндекс Пульта |
| <img src="./com.nbord.yandexsmarthome.streamdock.sdPlugin/static/icons/scenario.png" width="32"> | **Сценарий — Запустить / Крутилка** | Запуск и выбор сценариев |
| <img src="./com.nbord.yandexsmarthome.streamdock.sdPlugin/static/icons/plugin.png" width="32"> | **Умный дом — Панель / Сводка** | Открытие dashboard или информационная сводка |

> Доступность конкретных параметров зависит от возможностей устройства, которые возвращает API Яндекс Умного дома.

## Настройка кнопки и крутилки

![Настройка кнопки и крутилки](./screenshots/action-button-and-knob.png)

Для действий можно выбрать конкретное устройство и доступные параметры. Крутилки поддерживают настройку чувствительности и, где это уместно, ускорение вращения.

## Датчики

![Настройка датчика](./screenshots/action-sensor.png)

Для датчиков можно выбрать конкретный показатель и вариант отображения. Поддерживаются числовые свойства устройства — например температура, влажность, CO₂, PM2.5, PM10, TVOC, батарея и другие значения, если они доступны через API.

## Примеры управления крутилками

![Шторы, вентилятор, чайник и температура света](./screenshots/action-knob-examples.png)

Крутилки используются не только для яркости: тот же подход применяется к шторам, вентиляторам, чайникам, температуре света, громкости и другим диапазонным параметрам.

## Дополнительные действия

![Дополнительные действия Stream Dock](./screenshots/action-advanced-examples.png)

В том числе доступны:
- выбор цвета;
- световые пресеты;
- управление громкостью;
- команды ИК-пульта;
- сценарии;
- открытие локальной панели и вывод краткой сводки.

---

# Панель умного дома

Плагин включает отдельный локальный dashboard. Он не обязателен для использования кнопок и крутилок, но удобен для настройки дома и подробного управления устройствами.

## Тёмная тема

![Dashboard — тёмная тема](./screenshots/dashboard-dark.png)

## Светлая тема

![Dashboard — светлая тема](./screenshots/dashboard-light.png)

### Возможности панели

- комнаты, группы и отдельные устройства;
- поиск и фильтры;
- **Компактный / Обычный / Информативный** режимы карточек;
- ручной порядок комнат и устройств;
- отдельный порядок для избранного и сценариев;
- скрытие ненужных устройств;
- mixed-state для групп, если устройства имеют разные состояния;
- управление устройствами по их фактическим возможностям;
- настройка интервала обновления панели отдельно от Stream Dock;
- запоминание состояния интерфейса.

---

# Подробное управление устройствами

![Подробные карточки устройств](./screenshots/device-details.png)

В зависимости от `capabilities` устройства панель автоматически показывает подходящие элементы управления.

### Свет
- питание;
- яркость;
- температура белого света;
- RGB / HSV;
- доступные сцены и пресеты;
- управление группами света.

### Телевизоры и ИК
- питание;
- громкость;
- канал;
- источник;
- доступные toggle/mode-команды.

### Датчики
- текущие показатели;
- история;
- минимум, максимум и среднее;
- изменение за период;
- оценка текущего значения для некоторых типов показателей.

---

# История показателей

История числовых свойств собирается **локально на Mac** после установки плагина.

Доступны:
- `1 час`;
- `6 часов`;
- `24 часа`;
- интерактивный график;
- текущее значение;
- изменение за период;
- минимум и максимум с временем;
- среднее значение.

История может работать не только с отдельными датчиками, но и с устройствами, имеющими числовые свойства — например чайниками или очистителями воздуха.

---

# Избранное, сценарии и статистика

![Избранное и сценарии](./screenshots/favorites-scenarios.png)

- избранные устройства, группы и сценарии;
- запуск сценариев Яндекс Умного дома;
- собственный порядок элементов;
- статистика локального использования действий плагина.

![Статистика и общие настройки](./screenshots/statistics-settings.png)

---

# Подключение и диагностика

![Подключение и диагностика](./screenshots/settings-connection-diagnostics.png)

Встроенные настройки позволяют:
- сохранить и проверить OAuth-токен;
- настроить обновление панели;
- отдельно настроить частоту обновления кнопок и крутилок;
- выбрать стартовую страницу dashboard;
- проверить backend и соединение со Stream Dock;
- запустить безопасные авто-тесты;
- просмотреть журнал;
- выполнить полный сброс данных плагина.

---

# Совместимость

## Поддерживается сейчас

- **macOS**
- совместимые устройства **Stream Dock**

Плагин не привязан к одной конкретной модели. Набор доступных действий зависит от контроллеров конкретного устройства: на моделях без крутилок используются клавишные действия, а на моделях с крутилками становятся доступны соответствующие knob-действия.

## Протестировано

Первый публичный релиз протестирован на:

- **macOS Sequoia 15.7.3**
- **Stream Dock 3.10.203.0730**
- **miraBox N4**

Работа на других совместимых моделях предполагается архитектурой плагина, но конфигурация выше — та, на которой проверялся релиз `1.0.0`.

## Windows

Поддержка **Windows планируется позже**. Версия `1.0.0` предназначена для macOS.

---

# Установка

1. Откройте [Releases](https://github.com/n-bord/yandex-smart-home-stream-dock/releases).
2. Скачайте последнюю сборку для macOS.
3. Распакуйте архив.
4. Установите папку `com.nbord.yandexsmarthome.streamdock.sdPlugin` как локальный плагин Stream Dock.
5. При необходимости перезапустите Stream Dock.
6. Откройте **Яндекс Умный дом [n-bord] → Настройки → Подключение**.
7. Добавьте OAuth-токен Яндекса и выполните проверку.

---

# Подключение к Яндексу

Для работы требуется OAuth-токен с разрешениями:

```text
iot:view
iot:control
```

Для ручного получения токена можно использовать Redirect URI:

```text
https://oauth.yandex.ru/verification_code
```

Пример URL авторизации:

```text
https://oauth.yandex.ru/authorize?response_type=token&client_id=ВАШ_CLIENT_ID&force_confirm=yes
```

После авторизации в настройки плагина можно вставить:
- сам `access_token`;
- либо полный URL результата OAuth с `access_token` и `expires_in`.

Если плагин получает `expires_in`, он дополнительно сохраняет известный срок действия токена и отображает его в разделе подключения.

> **Не публикуйте OAuth-токен** в Issues, скриншотах, логах или сообщениях.

---

# Настройки и локальные данные

В плагине раздельно настраиваются:
- обновление локальной панели;
- обновление кнопок и крутилок Stream Dock;
- стартовая вкладка;
- тема;
- вид карточек;
- скрытые устройства;
- пользовательский порядок.

## Полный сброс

В настройках доступен полный сброс плагина. Он очищает локальные данные, включая:
- OAuth-авторизацию;
- историю показателей;
- статистику;
- кэш;
- избранное;
- скрытые устройства;
- порядок комнат, устройств и сценариев;
- параметры интерфейса;
- локальные настройки действий кнопок и крутилок;
- диагностические и временные данные.

После сброса плагин возвращается к состоянию новой установки.

---

# Конфиденциальность

- OAuth-токен используется для запросов к API Яндекс Умного дома.
- История показателей и пользовательские настройки хранятся локально.
- Не прикладывайте OAuth-токен к диагностическим материалам и публичным issue.

---

# Известные ограничения

- `1.0.0` — первый публичный релиз;
- релиз официально протестирован только на macOS и miraBox N4;
- доступность функций зависит от `capabilities` конкретного устройства;
- локальная история начинает накапливаться только после установки и запуска плагина;
- поддержка Windows пока не входит в `1.0.0`.

---

# Ошибки и предложения

Используйте [GitHub Issues](https://github.com/n-bord/yandex-smart-home-stream-dock/issues).

При сообщении об ошибке желательно указать:
- версию плагина;
- версию macOS;
- версию Stream Dock;
- модель Stream Dock;
- тип устройства Яндекс Умного дома;
- шаги воспроизведения;
- скриншот;
- диагностическую информацию **без OAuth-токена**.

---

# Поддержать проект

Если плагин оказался полезен и вы хотите поддержать дальнейшую разработку:

<p>
  <a href="https://boosty.to/nbord">
    <img src="https://img.shields.io/badge/Поддержать%20проект-на%20Boosty-F15F2C?style=for-the-badge" alt="Boosty">
  </a>
</p>

Поддержка не влияет на доступ к функциям плагина — проект остаётся публичным и доступным через GitHub.

---

# Автор

**nbord / n-bord**

- GitHub: [github.com/n-bord](https://github.com/n-bord)
- Проект: [github.com/n-bord/yandex-smart-home-stream-dock](https://github.com/n-bord/yandex-smart-home-stream-dock)

---

# Дисклеймер

**Яндекс**, **Умный дом**, названия продуктов и другие упомянутые товарные знаки принадлежат их правообладателям.

Этот проект является независимым **неофициальным любительским решением**, не аффилирован с компанией Яндекс и не поддерживается ею.
