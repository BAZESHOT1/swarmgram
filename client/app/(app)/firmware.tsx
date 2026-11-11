/**
 * Маршрут /firmware: визард сборки и прошивки ESP32-модуля.
 * Сборка идёт на Hub, запись — через Web Serial в Chromium-браузере.
 */
import React from 'react';
import { SettingsPage } from '../../src/components/settings/SettingsUI';
import { FirmwareWizard } from '../../src/components/firmware/FirmwareWizard';

export default function FirmwareScreen() {
  return (
    <SettingsPage
      title="Прошивка модуля"
      subtitle="Выберите плату и роль, соберите прошивку на Hub и запишите её по USB"
    >
      <FirmwareWizard />
    </SettingsPage>
  );
}
