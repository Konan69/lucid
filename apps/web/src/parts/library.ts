import { createLibrary } from '@openuidev/react-lang'
import {
  Badge,
  Box,
  Button,
  Caption,
  Card,
  Carousel,
  Chart,
  Checkbox,
  Col,
  Divider,
  Form,
  Grid,
  Icon,
  Image,
  Input,
  Label,
  Link,
  List,
  ListItem,
  MapMarker,
  MapView,
  Page,
  Pressable,
  RadioGroup,
  Row,
  Screen,
  SegmentedControl,
  Select,
  Spacer,
  Table,
  Text,
  TextArea,
  Title,
  Week,
} from '../../vendor/openui'

/**
 * Every part Vivid may draw a display from. It is a port of the Open Intelligent UI library
 * (thesysdev/open-intelligent-ui, `src/lib/library.ts`) cut down to what both the web app and the
 * phone can draw: no found photos, no embedded pages. The model arranges these parts itself; no
 * layout is fixed in them.
 *
 * The media parts are what a Feed card shows as the thing itself (the 13 October Feed): the
 * reference's `Map`, drawn as a picture on both surfaces (`vendor/openui/map.tsx`), and Vivid's
 * own `Week` strip, `Page` card and `Screen` of the Computer, written in OpenUI's own idiom
 * (`vendor/openui/media.css`, on the `--iui-*` theme) beside the parts they sit among.
 */
export const library = createLibrary({
  root: 'Col',
  components: [
    Col,
    Row,
    Box,
    Grid,
    Card,
    Carousel,
    Divider,
    Spacer,
    Title,
    Text,
    Caption,
    Label,
    Badge,
    Link,
    List,
    ListItem,
    Icon,
    Image,
    Table,
    Chart,
    MapView,
    MapMarker,
    Week,
    Page,
    Screen,
    Button,
    Pressable,
    Input,
    TextArea,
    Select,
    SegmentedControl,
    Checkbox,
    RadioGroup,
    Form,
  ],
  componentGroups: [
    {
      name: 'Layout',
      components: ['Col', 'Row', 'Box', 'Grid', 'Card', 'Carousel', 'Divider', 'Spacer'],
    },
    {
      name: 'Text',
      components: [
        'Title',
        'Text',
        'Caption',
        'Label',
        'Badge',
        'Link',
        'List',
        'ListItem',
        'Icon',
      ],
    },
    {
      name: 'Data and pictures',
      components: ['Table', 'Chart', 'Image', 'Map', 'MapMarker', 'Week', 'Page', 'Screen'],
    },
    {
      name: 'Inputs',
      components: [
        'Button',
        'Pressable',
        'Input',
        'TextArea',
        'Select',
        'SegmentedControl',
        'Checkbox',
        'RadioGroup',
        'Form',
      ],
    },
  ],
})
