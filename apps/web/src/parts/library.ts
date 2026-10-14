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
  Media,
  Pressable,
  RadioGroup,
  Row,
  SegmentedControl,
  Select,
  Spacer,
  Table,
  Text,
  TextArea,
  Title,
} from '../../vendor/openui'

/**
 * Every part Vivid may draw a display from. It is a port of the Open Intelligent UI library
 * (thesysdev/open-intelligent-ui, `src/lib/library.ts`) cut down to what both the web app and the
 * phone can draw: no map, no found photos, no embedded pages. The model arranges these parts
 * itself; no layout is fixed in them.
 */
export const library = createLibrary({
  root: 'Col',
  components: [
    Col, Row, Box, Grid, Card, Carousel, Media, Divider, Spacer,
    Title, Text, Caption, Label, Badge, Link, List, ListItem, Icon,
    Image, Table, Chart,
    Button, Pressable, Input, TextArea, Select, SegmentedControl, Checkbox, RadioGroup, Form,
  ],
  componentGroups: [
    { name: 'Layout', components: ['Col', 'Row', 'Box', 'Grid', 'Card', 'Carousel', 'Media', 'Divider', 'Spacer'] },
    { name: 'Text', components: ['Title', 'Text', 'Caption', 'Label', 'Badge', 'Link', 'List', 'ListItem', 'Icon'] },
    { name: 'Data and pictures', components: ['Table', 'Chart', 'Image'] },
    { name: 'Inputs', components: ['Button', 'Pressable', 'Input', 'TextArea', 'Select', 'SegmentedControl', 'Checkbox', 'RadioGroup', 'Form'] },
  ],
})

