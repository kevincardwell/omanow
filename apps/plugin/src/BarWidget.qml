import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "model.mjs" as Model

// Off until turned on. While on, says "an Omarchy machine is online in
// <city>" once an hour; the server forgets it about an hour after the last
// heartbeat. Only the city id and a random install id are ever sent.
Panel {
  id: root
  moduleName: "io.github.mark-omarov.omaglobe"
  ipcTarget: "omaglobe"

  readonly property string stateDir: Quickshell.env("HOME") + "/.local/state/omaglobe"
  readonly property string server: Model.serverUrl(setting("server", ""))
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  property string installId: ""
  property string city: ""
  property bool online: false
  property string suggestedCity: ""
  property var heat: null
  property string error: ""
  property bool loaded: false

  readonly property string pickedCity: city !== "" ? city : suggestedCity

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function save() {
    stateFile.setText(JSON.stringify({ id: installId, city: city, online: online }, null, 2) + "\n")
  }

  function request(path, body, done) {
    var xhr = new XMLHttpRequest()
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== XMLHttpRequest.DONE) return
      var data = null
      try { data = JSON.parse(xhr.responseText) } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300) {
        root.error = ""
        if (done) done(data)
      } else {
        root.error = xhr.status === 0 ? "can't reach " + root.server : (data && data.error) || "HTTP " + xhr.status
      }
    }
    xhr.open("POST", root.server + path)
    xhr.setRequestHeader("content-type", "application/json")
    xhr.send(JSON.stringify(body))
  }

  function heartbeat() {
    if (!online || installId === "" || city === "") return
    request("/api/online", { id: installId, city: city }, function (data) { root.heat = data ? data.heat : null })
  }

  function goOnline(id) {
    if (!id) return
    city = id
    online = true
    save()
    heartbeat()
  }

  function goOffline() {
    online = false
    save()
    if (installId !== "") request("/api/offline", { id: installId }, null)
  }

  function openGlobe() {
    Util.execArgv(["xdg-open", Model.themeLink(root.server, themeFile.text())])
  }

  // ~/.local/state/omaglobe/state.json: { id, city, online }. Kept out of
  // shell.json so a published dotfiles repo doesn't carry it.
  FileView {
    id: stateFile
    path: root.stateDir + "/state.json"
    printErrors: false
    onLoaded: {
      var s = Model.parseState(text())
      root.city = s.city
      root.online = s.online
      root.installId = s.id !== "" ? s.id : Model.newId()
      root.loaded = true
      root.heartbeat()
    }
    onLoadFailed: {
      root.installId = Model.newId()
      root.loaded = true
      mkdir.running = true
    }
  }

  Process {
    id: mkdir
    command: ["mkdir", "-p", root.stateDir]
    onExited: root.save()
  }

  FileView {
    id: weatherFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/settings/weather.json"
    printErrors: false
    onLoaded: root.suggestedCity = Model.cityFromWeather(text())
  }

  FileView {
    id: themeFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/current/theme/colors.toml"
    printErrors: false
    blockLoading: true
  }

  Timer {
    interval: Model.HEARTBEAT_MS
    running: root.online && root.loaded
    repeat: true
    onTriggered: root.heartbeat()
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰇧"
    dimmed: !root.online
    tooltipText: root.online ? "omaglobe: online from " + Model.cityLabel(root.city) : "omaglobe: off"
    onPressed: function (b) {
      if (b === Qt.RightButton) root.openGlobe()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(420))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function (direction) { root.switchPanel(direction) }

      Column {
        id: column
        width: parent.width
        spacing: Style.space(12)

        PanelHero {
          width: parent.width
          title: root.online ? Model.cityLabel(root.city) : "omaglobe"
          meta: root.online
            ? (Model.cityShown(root.heat, root.city) || !root.heat
              ? "online on the map"
              : "online · shows once " + root.heat.min + "+ people are here")
            : "off · nothing is sent"
          foreground: root.foreground
          fontFamily: root.fontFamily
          iconOpacity: root.online ? 1.0 : 0.5
          iconComponent: Component {
            Text {
              text: "󰇧"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.displayLarge
            }
          }
        }

        Text {
          visible: text !== ""
          width: parent.width
          text: Model.summary(root.heat)
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Text {
          visible: root.error !== ""
          width: parent.width
          text: root.error
          color: root.bar ? root.bar.urgent : Color.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        SearchableDropdown {
          id: picker
          width: parent.width
          label: "City"
          fontFamily: root.fontFamily
          placeholderText: "Search cities..."
          options: Model.cityOptions()
          value: root.pickedCity
          triggerLabel: root.pickedCity !== "" ? Model.cityLabel(root.pickedCity) : "Pick your city"
          onChanged: function (value) {
            if (root.online) root.goOnline(value)
            else root.city = value
          }
        }

        Button {
          width: parent.width
          text: root.online ? "Go offline" : "Show me on the map"
          fontFamily: root.fontFamily
          bordered: true
          enabled: root.online || root.pickedCity !== ""
          onClicked: root.online ? root.goOffline() : root.goOnline(root.pickedCity)
        }

        Button {
          width: parent.width
          text: "Open the globe in your theme"
          fontFamily: root.fontFamily
          onClicked: root.openGlobe()
        }

        Text {
          width: parent.width
          text: "Only the city is sent, never your location. Cities appear once 3 people are there. Off until you turn it on."
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }
    }
  }
}
